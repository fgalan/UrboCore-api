// Copyright 2017 Telefónica Digital España S.L.
//
// This file is part of UrboCore API.
//
// UrboCore API is free software: you can redistribute it and/or
// modify it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// UrboCore API is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
// General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with UrboCore API. If not, see http://www.gnu.org/licenses/.
//
// For those usages not covered by this license please contact with
// iot_support at tid dot es

'use strict';

var util = require('util');
var _ = require('underscore');
var moment = require('moment-timezone');
var MetadataModel = require('./metadatamodel');
var modelutils = require('./modelutils');
var UsersModel = require('./usersmodel');
var cons = require('../cons.js');
var utils = require('../utils');
var log = utils.log();
var auth = require('../auth.js');
var slug = require('node-slug').slug();
var bPromise = require('bluebird');
var pValid = bPromise.promisify(auth.validElements);
var config = require('../config');

function MetadataInstanceModel(cfg) {
  MetadataModel.call(this, cfg);
}

util.inherits(MetadataInstanceModel, MetadataModel);

MetadataInstanceModel.prototype.getAdminScopes = function(cb) {
  var query = [
    'SELECT DISTINCT ON (s.id_scope) s.id_scope as id, s.scope_name as name, s.status, s.timezone,',
    '(CASE WHEN (s.parent_id_scope IS NULL) THEN true ELSE false END) AS multi,',
    'array(SELECT DISTINCT c.id_category FROM metadata.categories_scopes c',
    'WHERE s.status = 1 AND c.id_scope = s.id_scope ORDER BY c.id_category',
    ') AS categories, ',
    'array(SELECT json_build_object(\'name\', name, \'surname\', surname) FROM public.users ',
    'where users_id = ANY((SELECT read_users FROM public.users_graph where name=s.id_scope )::bigint[]) GROUP BY users_id)  as users',
    'FROM metadata.scopes s LEFT JOIN metadata.variables_scopes v on s.id_scope=v.id_scope',
    'WHERE (s.parent_id_scope=\'orphan\' OR s.parent_id_scope is NULL)'
  ];
  this.query(query.join(' '), null, function(err, d) {
    if (err) return cb(err);
    return cb(null, d.rows);
  });
};

/*
{
  "name": "Junta de Andalucía",
  "location": [37.237364, -5.103308],
  "zoom": 15,
  "multi": true
}
*/

MetadataInstanceModel.prototype.createScope = function(data, cb) {
  var baseQry = ['BEGIN; INSERT INTO metadata.scopes (id_scope,scope_name,dbschema,geom,status,zoom,parent_id_scope, timezone,config) VALUES '];
  this.getReducedScopes((function(err, d) {

    // Auto-generated id_scope and dbschema
    var initial = 1;
    var baseSlug = data.name.replace(/ /g,'').replace(/-/g,'').slug();
    var proposedSchema = baseSlug;
    var proposedId = baseSlug;
    while (typeof _.findWhere(d, {dbschema: proposedSchema}) !== 'undefined') {
      proposedSchema = baseSlug + '_' + initial;
      proposedId = proposedSchema;
      initial++;
    }

    var geom = 'NULL';
    if (data.location) {
      var geom = '\'SRID=4326;POINT('+data.location[1]+' '+data.location[0]+')\'';
    }
    var timezone = data.timezone || moment.tz.guess();

    var values = {
      id_scope: '\'' + proposedId + '\'',
      scope_name: '\'' + data.name + '\'',
      dbschema: '\'' + proposedSchema + '\'',
      geom: geom,
      status: 0,
      zoom: data.zoom || 'NULL',
      parent_id_scope: function() {
        if (data.multi===false)
          if (typeof data.parent_id!=='undefined')
            return '\''+data.parent_id+'\'';
          else
            return '\'orphan\'';
        else
          return 'NULL';

      }(),
      timezone: '\'' + timezone + '\'',
      config: `'{"carto": {"account": "${config.getDefaultCARTOUser().user}"}}'::jsonb`,
    }
    var rawValues = _.values(values).join(',');
    var insertQry = baseQry + '(' + rawValues + ') RETURNING *;';

    if (!data.multi) {
      insertQry += 'CREATE SCHEMA IF NOT EXISTS ' + proposedSchema + ';';

    }

    insertQry += 'COMMIT;'
    try {
      this.query(insertQry, null, (function(err, d) {
        if (err) return cb(err);

        var metadata = new MetadataModel();
        // With super user
        metadata.getEntitiesMetadata(1, (function(err, catalogue) {
          if (err) {
            // TODO: DELETE JUST CREATED SCOPE
            // this.deleteScope(proposedId, cb);
          }
          else {
            // Insert scope ID with parent ID
            var parent = 'root'; // ALWAYS ROOT PARENT
            auth.findByName(parent, 1, (function(err, nodes) {
              var parent_id = nodes[0].id;
              auth.createEmptyNode(proposedId, parent_id, (function(err, d1) {

                if (!data.multi) { // Populate for not multi

                  // First create full graph
                  _.each(catalogue, function(category) {
                    auth.createEmptyNode(category.id, d1.rows[0].id, function(err, d2) {
                      _.each(category.entities, function(entity) {
                        auth.createEmptyNode(entity.id, d2.rows[0].id, function(err, d3) {
                          _.each(entity.variables, function(variable) {
                            auth.createEmptyNode(variable.id, d3.rows[0].id, function(err, d4) {
                              if (err) {
                                log.error('Error creating node for variable', variable.id)
                                log.error(err);
                              }
                            });
                          });
                        });
                      });
                    });
                  });

                  // Then add permissions to proposedId for every superadmin
                  var usersmodel = new UsersModel();
                  usersmodel.findSuperUsers(function(err, d5) {
                    _.each(d5.rows, function(user) {
                      usersmodel.users_graph_operation(proposedId, proposedId, user.users_id, 'read', 'add', function(err, d) {
                        if (err) {
                          log.error('ERROR GRANTING PERMISSIONS');
                          log.error(err);
                          log.error(d);
                        }
                      });
                    });
                    return cb(null, {id: proposedId});
                  });


                } else {
                  log.debug('MULTI');
                  // Add permissions to proposedId for every superadmin
                  var usersmodel = new UsersModel();
                  usersmodel.findSuperUsers(function(err, d5) {
                    _.each(d5.rows, function(user) {
                      usersmodel.users_graph_operation(proposedId, proposedId, user.users_id, 'read', 'add', function(err, d) {
                        if (err) {
                          log.error('ERROR GRANTING PERMISSIONS');
                          log.error(err);
                          log.error(d);
                        }
                      });
                    });
                    return cb(null, {id: proposedId});
                  });

                }


              }).bind(this));
            }).bind(this));
          }
        }).bind(this));

      }).bind(this));
    }
    catch (e) {
      return cb(e);
    }

  }).bind(this));
}

/*
{
  "name": "Osuna",
  "location": [37.237364, -5.103308],
  "zoom": 15,
  "dbschema": "osuna",
  "status":1
}
*/
MetadataInstanceModel.prototype.updateScope = function(scope, data, cb) {
  var baseQry = ['UPDATE metadata.scopes SET'];
  var updateClause = [];

    // Explicit validator and processor for updates
  if ('name' in data) {
    updateClause.push('scope_name=\''+data.name+'\'');
  }
  if ('location' in data) {
      // updateClause.push("geom=")
    updateClause.push('geom=\'SRID=4326;POINT('+data.location[1]+' '+data.location[0]+')\'');
  }
  if ('zoom' in data) {
    updateClause.push('zoom='+data.zoom);
  }
  if ('status' in data) {
    updateClause.push('status='+data.status);
  }
    // Database UNIQUE Should handle dups
  if ('dbschema' in data) {
    updateClause.push('dbschema=\''+data.dbschema+'\'');
  }

  if ('timezone' in data) {
    updateClause.push('timezone=\'' + data.timezone + '\'');
  }

  baseQry.push(updateClause.join(','));
  baseQry.push('WHERE id_scope=\''+scope+'\'');

  try {
    this.query(baseQry.join(' '), null, (err, d) => {
      if (err) return cb(err);

      return cb(null, { status: 'ok' });

    });
  }
  catch (e) {
    return cb(e);

  }


}

MetadataInstanceModel.prototype.deleteScope = function(scope, cb) {

  var delQry = `
      DELETE FROM
        metadata.scopes
      WHERE id_scope='${scope}'
      OR (parent_id_scope='${scope}' AND parent_id_scope!='orphan')`;


  this.query(delQry, null, function(err, d) {
    if (err) return cb(err);
    if (d.rowCount) {
        // DELETE FROM public.users_graph
      auth.deleteNodeByName(scope, function(err, d) {
        return cb(null, 'ok');
      });

    }
    else {
      return cb(null, 'not found');
    }
  });


};

MetadataInstanceModel.prototype.getScopeList = function(user_id, multi, cb) {
  var q_start = ['SELECT s.id_scope AS id, s.scope_name AS name,',

    'array(SELECT DISTINCT c.id_category',
    'FROM metadata.categories_scopes c',
    'WHERE s.status = 1 AND c.id_scope = ANY (CASE WHEN s.parent_id_scope IS NULL',
    'THEN array(SELECT sp.id_scope::text FROM metadata.scopes sp',
    'WHERE sp.parent_id_scope = s.id_scope)',
    'ELSE array[s.id_scope] END)',
    'ORDER BY c.id_category)',
    'AS categories,',

    '(SELECT count(*) FROM metadata.scopes sp JOIN public.users_graph ug ',
    'ON (sp.id_scope=ug.name AND (' + user_id + ' = ANY(ug.read_users) OR '+ user_id +' = ANY(ug.write_users)))',
    'WHERE sp.status = 1 AND sp.parent_id_scope IS NOT NULL',
    'AND sp.parent_id_scope = s.id_scope)',
    'AS n_cities,',

    '(CASE WHEN (s.parent_id_scope IS NULL)',
    'THEN true ELSE false END)',
    'AS multi',
    'FROM metadata.scopes s',
    'WHERE s.status=1 AND (s.parent_id_scope=\'orphan\' OR s.parent_id_scope is NULL)'];

  var q_multi = ['AND s.parent_id_scope IS NULL'];

  var q_no_multi = ['AND s.parent_id_scope IS NOT NULL'];

  var q_end = ['ORDER BY scope_name'];

  if (multi == null) {
    var q = q_start.concat(q_end);

  } else if (multi) {
    var q = q_start.concat(q_multi, q_end);

  } else {
    var q = q_start.concat(q_no_multi, q_end);
  }

  this.query(q.join(' '), null, function(err, d) {
    if (err) {
      log.error('Cannot execute sql query');
      log.error(q);
      return cb(err);
    }

    if (!d.rows.length) {
      log.debug('No rows returned from query');
      log.debug(q);
      return cb(null,null);
    }

    // remove not validElements
    var scopes = d.rows.map(function(r) {
      return r.id;
    });

    auth.validScopes({
      user_id: user_id,
      scopes : scopes
    }, function(err, valids) {
      if (err) {
        return cb(err);
      }

      var rows = d.rows.filter(function(row) {
        return valids.indexOf(row.id) !== -1;
      });

      rows = rows.map(function(row) {
        if (!row.multi) {
          delete row.n_cities;
        }
        return row;
      });


      var promises = [];
      rows.forEach(function(row) {
        promises.push(function() {

          var opts = {
            scope: row.id,
            user_id: user_id,
            elements: row.categories
          }

          return pValid(opts)
            .then(function(valids) {
              // Skip duplicates
              row.categories = Array.from(new Set(valids));
              return Promise.resolve(row);
            })
            .catch(function(err) {
              return Promise.reject(err);
            });

        }())
      });

      Promise.all(promises)
      .then(function(results) {
        return cb(null, results);
      })
      .catch(function(err) {
        return cb(err);
      })

    });
  });
};

MetadataInstanceModel.prototype.getReducedScopes = function(cb) {
  var q = ['SELECT s.id_scope AS id, s.scope_name AS name, s.dbschema, s.parent_id_scope AS parent_id,',
    'ARRAY[ST_Y(s.geom), ST_X(s.geom)] as location, s.zoom,',
    '(CASE WHEN (s.parent_id_scope IS NULL) THEN true ELSE false END) AS multi',
    'FROM metadata.scopes s'];

  this.query(q.join(' '), null, function(err, d) {
    if (err) return cb(err);
    return cb(null, d.rows);
  });
}


MetadataInstanceModel.prototype.getScopeForAdmin = function(scope, cb) {
  var _this = this;
  var q = ['SELECT s.id_scope AS id, s.dbschema, s.scope_name AS name, s.parent_id_scope AS parent_id,',
    'ARRAY[ST_Y(s.geom), ST_X(s.geom)] as location, s.zoom, s.status, ',
    'array(SELECT DISTINCT c.id_category',
    'FROM metadata.categories_scopes c',
    'WHERE c.id_scope = s.id_scope ORDER BY c.id_category',
    ') AS categories,',
    '(CASE WHEN (s.parent_id_scope IS NULL) THEN true ELSE false END) AS multi,',
    'array(SELECT sc.id_scope FROM metadata.scopes sc WHERE sc.parent_id_scope = s.id_scope) AS childs, ',
    'array(SELECT f.title FROM public.frames_scope f WHERE s.id_scope = f.scope_id) as frames',
    'FROM metadata.scopes s',
    'WHERE s.id_scope = ANY ($1)'];

  this.query(q.join(' '), [[scope]], function(err, s) {
    if (err) {
      log.error('Cannot execute sql query');
      log.error(q);
      return cb(err);
    }

    if (!s.rows.length) {
      log.debug('No rows returned from query');
      log.debug(q);
      return cb(null, null);
    }

    // If it isn't a multiscope, prepare it and return the resopnse
    if (!s.rows[0].multi) {
      delete s.rows[0].childs;
      return cb(null, s.rows[0]);
    }

    // If we are continuing it means that the request scope is a multiscope
    _this.query(q.join(' '), [s.rows[0].childs], function(err, sChilds) {
      if (err) {
        log.error('Cannot execute sql query');
        log.error(q);
        return cb(err);
      }

      // Preparing the childs before returning the response
      var childs = sChilds.rows.map(function(child) {
        delete child.multi;
        delete child.childs;
        delete child.parent_id;
        return child;
      });

      // Preparing the parent before returning the response
      s.rows[0].childs = childs;
      delete s.rows[0].parent_id;
      delete s.rows[0].categories;
      if (!s.rows[0].zoom) {
        delete s.rows[0].zoom;
      }
      if (!s.rows[0].location) {
        delete s.rows[0].location;
      }

      return cb(null, s.rows[0]);
    });
  });
};

MetadataInstanceModel.prototype.getScope = function(scope, user, cb) {
  var _this = this;
  var skipcheck = (user.id === cons.PUBLISHED);
  var user_id = skipcheck ? 1 : user.id;


  var q = ['SELECT s.id_scope AS id, s.dbschema, s.scope_name AS name, s.parent_id_scope AS parent_id,',
    'ARRAY[ST_Y(s.geom), ST_X(s.geom)] as location, s.zoom,',
    'array(SELECT DISTINCT c.id_category',
    'FROM metadata.categories_scopes c',
    'WHERE s.status = 1 AND c.id_scope = s.id_scope ORDER BY c.id_category',
    ') AS categories,',
    '(CASE WHEN (s.parent_id_scope IS NULL) THEN true ELSE false END) AS multi,',
    'array(SELECT sc.id_scope FROM metadata.scopes sc WHERE sc.parent_id_scope = s.id_scope) AS childs,',
    `array(SELECT json_build_object('widget', id_widget, 'published', json_agg(json_build_object('name',publish_name, 'token',token)))
                FROM metadata.scope_widgets_tokens WHERE id_scope='${scope}' GROUP BY id_widget) AS widgets, `,
    's.timezone, ',
    'array(SELECT f.title FROM public.frames_scope f WHERE s.id_scope = f.scope_id) as frames',
    'FROM metadata.scopes s JOIN public.users_graph ug ON s.id_scope=ug.name',
    'AND '+ user_id +' = ANY(ug.read_users)',
    'WHERE s.id_scope = ANY ($1)'];

  this.query(q.join(' '), [[scope]], function(err, s) {
    if (err) {
      log.error('Cannot execute sql query');
      log.error(q);
      return cb(err);
    }

    if (!s.rows.length) {
      log.debug('No rows returned from query');
      log.debug(q);
      return cb(null, null);
    }

    var element = s.rows[0];
    // If it isn't a multiscope, prepare it and return the resopnse
    if (!element.multi) {
      delete element.childs;


      if (skipcheck) return cb(null, element);

      var opts = {scope: element.id, user_id: user_id, elements: element.categories}
      return auth.validElements(opts, function(err, valids) {
        if (err) {
          return cb(err);
        }

        element.categories = valids;
        return cb(null, element);
      });
    }

    // If we are continuing it means that the request scope is a multiscope
    _this.query(q.join(' '), [element.childs], function(err, sChilds) {
      if (err) {
        log.error('Cannot execute sql query');
        log.error(q);
        return cb(err);
      }

      // Preparing the childs before returning the response
      var childs = sChilds.rows.map(function(child) {
        delete child.multi;
        delete child.childs;
        delete child.parent_id;
        return child;
      });

      // Preparing the parent before returning the response
      element.childs = childs;
      // delete element.zoom;
      // delete element.location;
      delete element.parent_id;
      delete element.categories;

      var promises = [];
      _.each(element.childs, function(child) {
        var opts = { scope: element.id, user_id: user_id, elements: child.categories };
        promises.push(function() {
          return pValid(opts).then(function(valids) {
            // Skip duplicates
            valids = Array.from(new Set(valids));
            child.categories = valids;
            return Promise.resolve(valids);
          })
          .catch(function(err) {
            return Promise.reject(err);
          });
        }())

      });

      Promise.all(promises).then(function(results) {
        // Returns only with categories
        var children = _.filter(element.childs, function(child) {
          return child.categories.length;
        })
        element.childs = children;
        return cb(null, element);
      })
      .catch(function(err) {
        if (cb) { return cb(err);}
      });

    });
  });
};

// /scopes/:scope/metadata
MetadataInstanceModel.prototype.getMetadataForScope = function(id_scope, user, cb) {
  var skipcheck = (user.id === cons.PUBLISHED);
  var user_id = skipcheck ? 1 : user.id;

  var q = this._getMetadataQueryForScope(id_scope, user);
  this.query(q, null, (function(err, d) {
    if (err) return cb(err);
    var dataset = this._dataset2metadata(d);

    // Check entities
    var promises = [];
    var varproms = [];

    _.each(dataset, function(category) {
      var entities = _.map(category.entities, function(entity) {
        return entity.id;
      });

      var opts = { scope: id_scope, user_id: user_id, elements: entities };
      promises.push(function() {

        if (skipcheck) return Promise.resolve(category.entities);

        return pValid(opts).then(function(valids) {
          // Skip duplicates
          valids = new Set(valids);
          category.entities = _.filter(category.entities, function(ce) {
            return valids.has(ce.id);
          });
          return Promise.resolve(valids);
        })
        .catch(function(err) {
          return Promise.reject(err);
        });
      }());

      _.each(category.entities, function(entity) {
        var variables = _.map(entity.variables, function(variable) {
          return variable.id
        });
        var opts = { scope: id_scope, user_id: user_id, elements: variables };
        varproms.push(function() {

          if (skipcheck) return Promise.resolve(entity.variables);

          return pValid(opts).then(function(valids) {
            // Skip duplicates
            valids = new Set(valids);
            entity.variables = _.filter(entity.variables, function(ev) {
              return valids.has(ev.id);
            });
            return Promise.resolve(valids);
          })
          .catch(function(err) {
            return Promise.reject(err);
          });
        }());
      })

    });

    Promise.all(promises).then(function(results) {
      return Promise.all(varproms).then(function() {
        return cb(null, dataset);
      });
    })
    .catch(function(err) {
      if (cb) { return cb(err);}
    });

  }).bind(this));
}

MetadataInstanceModel.prototype.getVarQuery = function(id_scope, id_variable, cb) {
  var varQry = `SELECT
    vs.var_name,
    vs.entity_field,
    vs.id_variable,
    (CASE WHEN vs.table_name IS NULL THEN es.table_name ELSE vs.table_name END) AS table_name,
    es.table_name AS entity_table_name
    FROM metadata.variables_scopes vs
    INNER JOIN metadata.entities_scopes es on vs.id_entity=es.id_entity
    WHERE vs.id_scope='${id_scope}' AND vs.id_variable='${id_variable}'`;

  if (cb)
    return this.query(varQry, null, this.cbRow(cb));
  else
    return this.promise_query(varQry, null);
}

MetadataInstanceModel.prototype.getVarQueryArray = function(scope, variables, cb) {
  if (variables.constructor === Array) {
    variables = variables.join(',');
  }
  var vars = _.map(variables.split(','), function(ent) {return modelutils.wrapStrings(ent, '\'')});
  var varQry = ['WITH q AS',
    '(SELECT e.id_entity,s.dbschema, ',
    '(CASE WHEN v.table_name IS NULL THEN e.table_name ELSE v.table_name END) AS table_name,',
    'e.table_name AS entity_table_name,',
    'v.entity_field,v.id_variable',
    'FROM metadata.scopes s',
    'INNER JOIN metadata.categories_scopes c on c.id_scope = s.id_scope',
    'INNER JOIN metadata.entities_scopes e on c.id_category=e.id_category',
    'INNER JOIN metadata.variables_scopes v on v.id_entity=e.id_entity',
    util.format('WHERE s.status = 1 AND s.id_scope=\'%s\' AND v.id_variable IN (%s))', scope, vars),
    'SELECT id_entity,dbschema, table_name, entity_table_name, array_agg(entity_field) AS vars,array_agg(id_variable) AS vars_ids',
    'FROM q GROUP BY table_name, entity_table_name, dbschema, id_entity'];

  if (cb)
    return this.query(varQry.join(' '), null, function(err, d) {
      if (err) return cb(err);
      return cb(null, d);
    });
  else
    return this.promise_query(varQry.join(' '), null);
}

MetadataInstanceModel.prototype.getVarQueryArrayMultiEnt = function(scope, variables, cb) {
  var vars = _.map(variables.split(','), function(ent) {return modelutils.wrapStrings(ent, '\'')});
  var varQry = ['WITH q AS',
    '(SELECT DISTINCT ON(v.id_variable) e.id_entity,s.id_scope,s.dbschema,',
    '(CASE WHEN v.table_name IS NULL THEN e.table_name ELSE v.table_name END) AS table_name,',
    'e.table_name AS entity_table_name, ',
    'v.entity_field,v.id_variable',
    'FROM metadata.scopes s',
    'INNER JOIN metadata.categories_scopes c on c.id_scope = s.id_scope',
    'INNER JOIN metadata.entities_scopes e on c.id_category=e.id_category',
    'INNER JOIN metadata.variables_scopes v on v.id_entity=e.id_entity',
    util.format('WHERE s.status = 1 AND s.id_scope=\'%s\' AND v.id_variable IN (%s))', scope, vars),
    'SELECT id_scope,dbschema,array_agg(table_name) as tablenames,array_agg(entity_table_name) AS entitytables, array_agg(entity_field) AS vars,',
    'array_agg(id_variable) AS vars_ids',
    'FROM q GROUP BY id_scope,dbschema'];

  if (cb)
    return this.query(varQry.join(' '), null, function(err, d) {
      if (err) return cb(err);
      return cb(null, d);
    });
  else
    return this.promise_query(varQry.join(' '), null);
}



MetadataInstanceModel.prototype.getVariableForAgg = function(scope, variables, cb) {

  variables = Array.isArray(variables) ? variables : variables.split(',');

  var vars = _.map(variables, function(ent) {
    return modelutils.wrapStrings(ent, '\'')
  });

  var varQry = ['WITH q AS',
    '(SELECT e.id_entity,s.dbschema, ',
    '(CASE WHEN v.table_name IS NULL THEN e.table_name ELSE v.table_name END) AS table_name,',
    'e.table_name as entity_table_name, ',
    'v.entity_field,v.id_variable',
    'FROM metadata.scopes s',
    'INNER JOIN metadata.categories_scopes c on c.id_scope = s.id_scope',
    'INNER JOIN metadata.entities_scopes e on c.id_category=e.id_category',
    'INNER JOIN metadata.variables_scopes v on v.id_entity=e.id_entity',
    util.format('WHERE s.status = 1 AND s.id_scope=\'%s\' AND v.id_variable IN (%s))', scope, vars),
    'SELECT DISTINCT ON (id_variable) id_variable,id_entity,dbschema, table_name, entity_table_name, entity_field',
    'FROM q'];

  if (cb)
    return this.query(varQry.join(' '), null, function(err, d) {
      if (err) return cb(err);
      return cb(null, d);
    });
  else
    return this.promise_query(varQry.join(' '), null);
}

MetadataInstanceModel.prototype.getVarsForRawData= function(scope, entity, variables) {

  variables = Array.isArray(variables) ? variables : variables.split(',');

  var vars = _.map(variables, function(ent) {
    return modelutils.wrapStrings(ent, '\'')
  });

  var varQry = ['WITH',
    `_et as (SELECT table_name FROM metadata.entities_scopes WHERE id_entity='${entity}' LIMIT 1),`,
    `_st as (SELECT dbschema FROM metadata.scopes WHERE id_scope='${scope}'),`,
    '_mt as (SELECT coalesce(table_name,(SELECT table_name FROM _et)) as tbl_nm,id_variable,entity_field',
    'FROM metadata.variables_scopes',
    `WHERE id_entity='${entity}' AND id_scope='${scope}' AND id_variable IN (${vars}))`,
    'SELECT tbl_nm as table_name,json_agg(json_build_object(\'id_var\',id_variable,\'field\',entity_field)) as varfields,',
    '(SELECT dbschema FROM _st) as dbschema',
    'FROM _mt GROUP BY tbl_nm'];

  return this.promise_query(varQry.join(' '), null);
}


MetadataInstanceModel.prototype.getEntsForSearch = function(scope,entities, cb) {
  var ents = _.map(entities, function(ent) {return modelutils.wrapStrings(ent, '\'')});
  var varAggQry = ['WITH q AS',
    '(SELECT distinct e.id_entity,s.dbschema,',
    '(CASE WHEN v.table_name IS NULL THEN e.table_name ELSE v.table_name END) AS table_name, ',
    'e.table_name AS entity_table_name ',
    'FROM metadata.scopes s',
    'INNER JOIN metadata.categories_scopes c on c.id_scope = s.id_scope',
    'INNER JOIN metadata.entities_scopes e on c.id_category=e.id_category',
    'INNER JOIN metadata.variables_scopes v on v.id_entity=e.id_entity ',
    util.format('WHERE s.status = 1 AND s.id_scope=\'%s\' AND e.id_entity IN (%s) AND v.type != \'aggregated\')',scope,ents),
    'SELECT id_entity,dbschema,table_name, entity_table_name',
    'FROM q'];

  if (cb)
    return this.query(varAggQry.join(' '), null, function(err, d) {
      if (err) return cb(err);
      return cb(null, d);
    });
  else
    return this.promise_query(varAggQry.join(' '), null);
}


MetadataInstanceModel.prototype._getMetadataQueryForScope = function(id_scope, user) {

  var mtdQry = [
    'SELECT DISTINCT c.category_name, c.id_category, c.nodata, c.config AS category_config, ',
    '(CASE WHEN v.table_name IS NULL THEN e.table_name ELSE v.table_name END) AS table_name,',
    ' e.entity_name, ',
    ' e.mandatory as entity_mandatory, e.table_name as entity_table_name, e.editable as entity_editable, ',
    'v.id_variable as id_variable, v.id_entity, v.var_name, v.var_units, ',
    'v.var_thresholds, v.var_agg, v.var_reverse, v.mandatory as variable_mandatory, v.editable as variable_editable, ',
    'v.entity_field as column_name, v.config',
    'FROM metadata.scopes s',
    'LEFT JOIN metadata.categories_scopes c on c.id_scope=s.id_scope',
    'LEFT JOIN metadata.entities_scopes e on (e.id_category=c.id_category AND e.id_scope=s.id_scope)',
    'LEFT JOIN metadata.variables_scopes v on (v.id_entity=e.id_entity AND v.id_scope=s.id_scope)'
  ];

  var whereClause = 'WHERE s.id_scope=\''+id_scope+'\'';
  if (!user.superadmin) {
    whereClause += ' AND s.status = 1';
  }

  mtdQry.push(whereClause);
  return mtdQry.join(' ');

}


//DEPRECATED
MetadataInstanceModel.prototype.getMapCounters = function(scope,opts,cb) {
  // GET TABLE
  var q = ['SELECT de.table_name as table,de.id_entity,json_agg(json_build_object(\'field\',dv.entity_field,\'variable\',dv.id_variable)) as fields',
    'FROM metadata.variables_scopes dv ',
    'INNER JOIN metadata.entities_scopes de ON dv.id_entity=de.id_entity',
    'INNER JOIN metadata.scopes s ON s.id_scope = v.id_scope',
    'WHERE s.status = 1 AND dv.id_entity IN (\'' + opts.entities.join('\',\'') + '\')',
    'GROUP BY de.table_name,de.id_entity'];

  this.query(q.join(' '), null, function(err, d) {
    if (err) return cb(err);
    return cb(null, d);
  });
};

// TODO: Find a proper name
MetadataInstanceModel.prototype.getAllElementsByDevice = function(scope,id_entity,cb) {

  var qm = ['SELECT e.id_entity,s.dbschema,',
    '(CASE WHEN v.table_name IS NULL THEN e.table_name ELSE v.table_name END) AS table_name,',
    ' e.table_name AS entity_table_name ',
    'FROM metadata.scopes s',
    'INNER JOIN metadata.entities_scopes e on e.id_scope = s.id_scope',
    'INNER JOIN metadata.variables_scopes v on v.id_entity = e.id_entity',
    'WHERE s.status = 1 AND s.id_scope=$1 AND e.id_entity=$2'];

  this.query(qm.join(' '),[scope,id_entity], function(err,d) {
    if (err) return cb(err);
    return cb(null, d);
  });
};


MetadataInstanceModel.prototype.getMetadataQueryForDeviceLastData = function(scope, id_entity, cb) {
  var mtdQry = ['WITH q AS',
    '(SELECT DISTINCT ON(v.id_variable) s.dbschema, e.entity_name,',
    'e.table_name,',
    'c.category_name, ',
    'v.id_variable,e.id_entity,v.entity_field, v.var_name, v.var_units, v.var_agg',
    'FROM metadata.scopes s',
    'INNER JOIN metadata.categories_scopes c on c.id_scope = s.id_scope',
    'INNER JOIN metadata.entities_scopes e on c.id_category=e.id_category',
    'INNER JOIN metadata.variables_scopes v on v.id_entity=e.id_entity',
    'WHERE s.id_scope=$1 AND e.id_entity=$2 AND s.status=1 AND v.type!=\'aggregated\') ',
    'SELECT table_name, dbschema, id_entity, entity_name, category_name, ',
    'array_agg(id_variable) AS vars_ids, ',
    'array_agg(entity_field) AS vars, ',
    'array_agg(var_name) AS varname, ',
    'array_agg(var_units) AS varunits,',
    'array_agg(array_to_string(var_agg, \';\')) AS varagg ',
    'FROM q GROUP BY table_name, dbschema, id_entity,entity_name,category_name'];

  this.query(mtdQry.join(' '), [scope, id_entity], function(err,d) {
    if (err) return cb(err);
    return cb(null, d);
  });
}

MetadataModel.prototype.entityVariablesFields = function(id_scope, id_entity,cb) {
  var sql = `
    SELECT json_agg(json_build_object('id_var',id_variable,'field',entity_field)) as varfields,
            (select table_name from metadata.entities_scopes WHERE id_entity='${id_entity}' LIMIT 1) as table
            FROM metadata.variables_scopes WHERE id_entity='${id_entity}' AND id_scope='${id_scope}'`;

  this.query(sql, null, this.cbRow(cb));
}


// NOT USED ?
// DEPRECATED ?
MetadataInstanceModel.prototype.getMapMetadataQuery = function(scope, cb) {
  var mapMtdQry = ['WITH q AS'
        + '(SELECT s.dbschema, e.entity_name, e.table_name, c.category_name, '
        + 'v.id_variable,v.id_entity,v.entity_field, v.config, v.var_name, v.var_units '
        +   'FROM metadata.scopes s '
        +  'INNER JOIN metadata.categories_scopes c on c.id_scope = s.id_scope '
        +  'INNER JOIN metadata.entities_scopes e on c.id_category=e.id_category '
        +  'INNER JOIN metadata.variables_scopes v on v.id_entity=e.id_entity '
        + 'WHERE s.status = 1 AND s.id_scope=$1) '
        + 'SELECT table_name, dbschema, id_entity,entity_name, '
        + 'array_agg(id_variable) AS vars_ids, '
        + 'array_agg(entity_field) AS vars, '
        + 'array_agg(var_name) AS varname, '
        + 'array_agg(var_units) AS varunits '
        + 'FROM q GROUP BY table_name,dbschema,id_entity,entity_name'];

  this.query(mapMtdQry.join(' '), [scope], function(err,d) {
    if (err) return cb(err);
    return cb(null, d);
  });

}


MetadataInstanceModel.prototype.getEntitiesForDevicesMapByEntity = function(scope, entities, cb) {

  var dev_ents = _.map(entities.split(','), function(ent) {return modelutils.wrapStrings(ent, '\'')});
  var q = `WITH q AS (
        SELECT vs.id_entity, vs.id_scope AS dbschema,
            es.table_name, vs.entity_field, vs.id_variable
          FROM metadata.variables_scopes vs
            INNER JOIN metadata.entities_scopes es
            ON vs.id_entity = es.id_entity
          WHERE vs.id_scope = $1 AND vs.id_entity IN (${ dev_ents })
            AND es.id_scope = $1 AND es.id_entity IN (${ dev_ents })
            AND vs.type <> 'aggregated'
      )
      SELECT id_entity, dbschema, table_name, array_agg(entity_field) AS vars, array_agg(id_variable) AS id_vars
        FROM q
        GROUP BY id_entity, dbschema, table_name`;

  if (cb) {
    return this.query(q, [scope], cb);

  } else {
    return this.promise_query(q, [scope]);
  }
}

MetadataInstanceModel.prototype.getEntitiesForDevicesMapByScope = function(scope, entities, cb) {

  var dev_ents = _.map(entities.split(','), function(ent) {return modelutils.wrapStrings(ent, '\'')});
  var q = ['SELECT e.id_entity,s.dbschema, e.table_name FROM metadata.scopes s',
    'INNER JOIN metadata.entities_scopes e on e.id_scope = s.id_scope',
    'WHERE s.status = 1 AND s.id_scope=$1 AND e.id_entity IN (',dev_ents,')'];

  if (cb) {
    return this.query(q.join(' '), [scope], cb);

  } else {
    return this.promise_query(q.join(' '), [scope]);
  }
}

MetadataInstanceModel.prototype.getChildrenForScope = function(scope, cb) {
  var q = 'SELECT id_scope as id, scope_name as name, status from metadata.scopes where parent_id_scope=\''+scope+'\'';
  this.query(q, null, function(err, children) {
    if (err) return cb(err);
    return cb(null, children.rows);
  })
}


MetadataInstanceModel.prototype.getCARTOAccountsAndCategories = function() {
  var q = 'select config->\'carto\'->\'account\' as account,id_category from metadata.categories_scopes group by config->\'carto\'->\'account\',id_category';
  return this.promise_query(q);
}

MetadataInstanceModel.prototype.getCARTOAccount = function(id_scope,id_category) {
  var ending = id_category ? ` AND a.id_category = '${id_category}'` : '';

  var q = `SELECT CASE
          WHEN id_category = '${id_category}' THEN a.config->'carto'->'account'
          ELSE b.config->'carto'->'account'
        END as account
      FROM metadata.categories_scopes a
      RIGHT JOIN metadata.scopes b
        ON a.id_scope = b.id_scope
      WHERE b.id_scope = '${id_scope}'${ending}`;

  return this.promise_query(q);
}

MetadataInstanceModel.prototype.getAggVarsFromEntity = function(scope, entity) {
  var q = `SELECT array_agg(entity_field) AS columns, table_name AS table
      FROM metadata.variables_scopes
      WHERE id_scope = '${ scope }'
        AND id_entity = '${ entity }'
        AND type = 'aggregated'
      GROUP BY table_name`;

  return this.promise_query(q);
};

MetadataInstanceModel.prototype.getEntityTable = function(scope, entity) {
  var q = `SELECT table_name AS table
      FROM metadata.entities_scopes
      WHERE id_scope = '${ scope }' AND id_entity = '${ entity }'`;

  return this.promise_query(q);
};

module.exports = MetadataInstanceModel;
