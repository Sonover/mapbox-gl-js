'use strict';
var Pako = require('pako');
const Evented = require('../util/evented');
const util = require('../util/util');
const loadTileJSON = require('./load_tilejson');
const normalizeURL = require('../util/mapbox').normalizeTileURL;

class VectorTileSource extends Evented {

    constructor(id, options, dispatcher, eventedParent) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;

        this.type = 'vector';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this.reparseOverscaled = true;
        this.isTileClipped = true;
        util.extend(this, util.pick(options, ['url', 'scheme', 'tileSize']));

        this._options = util.extend({ type: 'vector' }, options);

        if (this.tileSize !== 512) {
            throw new Error('vector tile sources must have a tileSize of 512');
        }

        this.setEventedParent(eventedParent);
        this.fire('dataloading', {dataType: 'source'});

        loadTileJSON(options, (err, tileJSON) => {
            if (err) {
                this.fire('error', err);
                return;
            }
            util.extend(this, tileJSON);
            this.fire('data', {dataType: 'source'});
            this.fire('source.load');
        });
    }

    onAdd(map) {
        this.map = map;
    }

    serialize() {
        return util.extend({}, this._options);
    }

    loadTile(tile, callback) {
        const overscaling = tile.coord.z > this.maxzoom ? Math.pow(2, tile.coord.z - this.maxzoom) : 1;
        const params = {
            url: normalizeURL(tile.coord.url(this.tiles, this.maxzoom, this.scheme), this.url),
            uid: tile.uid,
            coord: tile.coord,
            zoom: tile.coord.z,
            tileSize: this.tileSize * overscaling,
            type: this.type,
            source: this.id,
            overscaling: overscaling,
            angle: this.map.transform.angle,
            pitch: this.map.transform.pitch,
            showCollisionBoxes: this.map.showCollisionBoxes
        };

        if (!tile.workerID) {
            //tile.workerID = this.dispatcher.send('load tile', params, done.bind(this));

            var url = params.url.split('/'),
                z = url[0],
                x = url[1],
                y = url[2];
            y = (1 << z) - 1 - y;
            //this.copyDatabaseFile(params.source + ".mbtiles").then(function() {
            var dbname = params.source + ".mbtiles";
            var store_location = 2;
            var that = this;
            window.plugins.sqlDB.copy(dbname, store_location, function(){
                if (!that.db) {
                    that.db = window.sqlitePlugin.openDatabase({
                        name: params.source + '.mbtiles',
                        location: 2,
                        createFromLocation: 1,
                        androidDatabaseImplementation: 2
                    });
                }

                that.db.transaction(function(tx) {
                    tx.executeSql("SELECT tile_data FROM tiles WHERE zoom_level = " + z + " AND tile_column = " + x + " AND tile_row =" + y, [], function (tx, res) {
                        try {
                            if(res.rows.item(0)){
                                var tileData = res.rows.item(0).tile_data,
                                    tileDataDecoded = window.atob(tileData),
                                    tileDataDecodedLength = tileDataDecoded.length,
                                    tileDataTypedArray = new Uint8Array(tileDataDecodedLength);
                                for (var i = 0; i < tileDataDecodedLength; ++i) {
                                    tileDataTypedArray[i] = tileDataDecoded.charCodeAt(i);
                                }
                                var tileDataInflated = Pako.inflate(tileDataTypedArray);
                                params.tileData = tileDataInflated;
                                tile.workerID = that.dispatcher.send('loadTile', params, done.bind(that));
                            }else{
                                console.log("No Results",res.rows);
                            }

                        } catch (error) {
                            console.log("Error after select", error);
                        }
                    }.bind(this),function(error, y){
                        console.log("Error on Getting tiles: ",error,y);
                    });
                }.bind(this), function(error) {
                    console.log('transaction error: ' + error);
                }, function() {
                    console.log('transaction ok');
                });
            },function(error){
                if(error.code = 516){
                    if (!that.db) {
                        that.db = window.sqlitePlugin.openDatabase({
                            name: params.source + '.mbtiles',
                            location: 2,
                            createFromLocation: 1,
                            androidDatabaseImplementation: 2
                        });
                    }

                    that.db.transaction(function(tx) {
                        tx.executeSql("SELECT tile_data FROM tiles WHERE zoom_level = " + z + " AND tile_column = " + x + " AND tile_row =" + y, [], function (tx, res) {
                            try {
                                if(res.rows.item(0)){
                                    var tileData = res.rows.item(0).tile_data,
                                        tileDataDecoded = window.atob(tileData),
                                        tileDataDecodedLength = tileDataDecoded.length,
                                        tileDataTypedArray = new Uint8Array(tileDataDecodedLength);
                                    for (var i = 0; i < tileDataDecodedLength; ++i) {
                                        tileDataTypedArray[i] = tileDataDecoded.charCodeAt(i);
                                    }
                                    var tileDataInflated = Pako.inflate(tileDataTypedArray);
                                    params.tileData = tileDataInflated;
                                    tile.workerID = that.dispatcher.send('loadTile', params, done.bind(that));
                                }else{
                                    console.log("No Results",res.rows);
                                }

                            } catch (error) {
                                console.log("Error after select", error);
                            }
                        }.bind(this),function(error, y){
                            console.log("Error on Getting tiles: ",error,y);
                        });
                    }.bind(this), function(error) {
                        console.log('transaction error: ' + error);
                    }, function() {
                        console.log('transaction ok');
                    });
                }
            });

            /*}.bind(this)).catch(function(err) {
                console.log("File Write Error", err);
            });*/
        } else if (tile.state === 'loading') {
            // schedule tile reloading after it has been loaded
            tile.reloadCallback = callback;
        } else {
            this.dispatcher.send('reloadTile', params, done.bind(this), tile.workerID);
        }

        function done(err, data) {
            if (tile.aborted)
                return;

            if (err) {
                return callback(err);
            }

            tile.loadVectorData(data, this.map.painter);

            if (tile.redoWhenDone) {
                tile.redoWhenDone = false;
                tile.redoPlacement(this);
            }

            callback(null);

            if (tile.reloadCallback) {
                this.loadTile(tile, tile.reloadCallback);
                tile.reloadCallback = null;
            }
        }
    }

    abortTile(tile) {
        this.dispatcher.send('abortTile', { uid: tile.uid, type: this.type, source: this.id }, null, tile.workerID);
    }

    unloadTile(tile) {
        tile.unloadVectorData();
        this.dispatcher.send('removeTile', { uid: tile.uid, type: this.type, source: this.id }, null, tile.workerID);
    }
}

module.exports = VectorTileSource;
