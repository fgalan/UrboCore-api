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

const GeoJSONFormatter = require('../protools/geojsonformatter.js');
const MetadataInstanceModel = require('./metadatainstancemodel');
const PGSQLModel = require('./pgsqlmodel.js');
const QueryBuilder = require('../protools/querybuilder.js');
const utils = require('../utils.js');

const log = utils.log();

class MapsModel extends PGSQLModel {
  constructor(cfg) {
    super(cfg);
  }

  get this() {
    return this;  // Because parent is not a strict class
  }

  entities(opts) {
    let metaInstModel =  new MetadataInstanceModel();
    let promises = [
      metaInstModel.getEntitiesForDevicesMapByEntity(opts.scope, opts.entity),
      metaInstModel.getAggVarsFromEntity(opts.scope, opts.entity)
    ];

    if (opts.variable) {
      promises.push(metaInstModel.getVarQuery(opts.scope, opts.variable));
    }

    return Promise.all(promises)
    .then((data) => {
      let vars = data[0].rows;
      let aggVars = data[1].rows;

      if (!vars.length) {
        return this.entitiesStatic(opts);

      } else {
        vars = vars[0];
      }

      let qb = new QueryBuilder(opts);
      let bbox = qb.bbox();
      let filter = qb.filter();

      let schema = vars.dbschema;
      let table = vars.table_name;
      let columns = ['id_entity', 'ST_AsGeoJSON(position) AS geometry',
        '"TimeInstant"', ...vars.vars];

      let sql = `SELECT *
          FROM (
            SELECT ${ columns.join(', ') }
              FROM ${ schema }.${ table }_lastdata
              WHERE TRUE ${ bbox } ${ filter }
          ) ld`;

      for (let i = 0; i < aggVars.length; i++) {
        sql += ` LEFT JOIN (
            SELECT id_entity AS id_entity_tmp, ${ aggVars[i].columns.join(', ') }
              FROM (
                SELECT id_entity, ${ aggVars[i].columns.join(', ') },
                    ROW_NUMBER() OVER(PARTITION BY id_entity ORDER BY "TimeInstant" DESC) AS rn
                  FROM ${ schema }.${ aggVars[i].table }
                  WHERE "TimeInstant" > now() - interval '${ opts.lastdataHoursInterval } hours'
                    AND "TimeInstant" <= now()
              ) s_agg${ i }
              WHERE rn = 1
          ) agg${ i }
            ON ld.id_entity = agg${ i }.id_entity_tmp`;
      }

      if (opts.variable) {
        let varData = data[2].rows[0];

        sql = `SELECT *
          FROM (
              ${ sql }
          ) q_entity
            LEFT JOIN (
              SELECT id_entity AS id_entity_tmp,
                  ${ opts.agg }(${ varData.entity_field }) AS "${ opts.variable }"
                FROM ${ schema }.${ varData.table_name }
                WHERE "TimeInstant" >= '${opts.start}'::timestamp
                  AND "TimeInstant" < '${opts.finish}'::timestamp
                GROUP BY id_entity
            ) q_variable
              ON q_entity.id_entity = q_variable.id_entity_tmp`;
      }

      return this.cachedQuery(sql, null);
    })

    .then((data) => {
      data = new GeoJSONFormatter().featureCollection(data.rows);
      return Promise.resolve(data);
    })

    .catch((err) => {
      return Promise.reject(err);
    });
  }

  entitiesStatic(opts) {
    return new MetadataInstanceModel().getEntityTable(opts.scope, opts.entity)
    .then((data) => {
      if (!data.rows.length) {
        let err = new Error('No entity or variables for the sent parameters');
        err.status = 400;
        return Promise.reject(err);
      }

      let table = data.rows[0].table;

      let sql = `SELECT *, ST_AsGeoJSON(position) AS geometry
          FROM ${ opts.scope }.${ table }`;
      return this.cachedQuery(sql, null);
    })

    .catch((err) => {
      return Promise.reject(err);
    });
  }

}

module.exports = MapsModel;
