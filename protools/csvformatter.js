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

var _ = require('underscore');
var utils = require('../utils');
var log = utils.log();
var json2csv = require('json2csv');
var BaseFormatter = require('./baseformatter');

class CSVFormatter extends BaseFormatter {

  constructor() {
    super();
  }

  formatTimeSerie(data) {

    var fields = ['time'];
    var first = true;

    data.forEach(function(ts) {
      for (var variable in ts.data) {
        var asVariable = ts.data[variable];
        if (asVariable instanceof Array) {
          for (var agg of asVariable) {
            var varname = `${variable}_${agg.agg}`;
            ts[varname] = agg.value
            if (first) fields.push(varname);
          }
        }
        else {
          ts[variable] = asVariable;
          if (first) fields.push(variable);
        }
      }
      if (first) first = false;

    });

    return json2csv({
      data: data,
      fields: fields,
      doubleQuotes: '',
      del: ';'});
  }

}

module.exports = CSVFormatter;
