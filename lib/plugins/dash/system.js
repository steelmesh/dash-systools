var debug = require('debug')('dash-systools'),
    fs = require('fs'),
    path = require('path'),
    exec = require('child_process').exec,
    viewsPath = path.resolve(__dirname, '../../views'),
    _ = require('underscore'),
    _activeWorkers = [],
    _configFiles = {};
    
function _getWorkers(req, page, callback) {
    callback({
        workers: _activeWorkers
    });
}
    
function _handleActions(msg) {
    if (msg.action) {
        debug('captured action: ', msg);
        
        switch (msg.action) {
            case 'worker-online': {
                var entry = _.find(_activeWorkers, function(entry) {
                        return entry.pid === msg.pid;
                    });
                    
                // if we don't have an entry then add it to the list
                if (! entry) {
                    _activeWorkers.push({
                        pid: msg.pid,
                        active: true,
                        started: new Date()
                    });
                }
                
                break;
            }
            
            case 'shutdown': {
                var targets = _.map(_activeWorkers, function(entry) {
                        return msg.targets.indexOf(entry.pid) >= 0;
                    });
                    
                // iterate through the targets and update the active status
                // and shutdown time
                targets.forEach(function(target) {
                    target.active = false;
                    target.stopped = new Date();
                });

                break;
            }
        }
    }
} // _handleActions

function _loadConfigFiles(dash) {
    var configPath = path.resolve(dash.serverPath, 'config');
    
    fs.readdir(configPath, function(err, files) {
        if (! err) {
            files.forEach(function(file) {
                fs.readFile(path.join(configPath, file), 'utf8', function(err, data) {
                    if (! err) {
                        _configFiles[file] = data;
                    }
                });
            });
        }
    });
} // _logConfigFiles
    
exports.connect = function(server, config, dash, callback) {
    var navItems = [
        { url: '/system/config', title: 'Config' },
        { url: '/system/environment', title: 'Environment' },
        { url: '/system/workers', title: 'Workers' },
        { url: '/system/packages', title: 'Packages' }
    ];
    
    // add message listeners
    dash.messenger.on('action', _handleActions);
    
    // load the config files
    _loadConfigFiles(dash);
    
    // set the upload path
    callback({
        loaders: {
            'system/config': function(req, page, callback) {
                callback({
                    config: JSON.stringify(config),
                    configFiles: _configFiles
                });
            },
            
            'system/environment': function(req, page, callback) {
                callback({
                    env: process.env
                });
            },
            
            'system/workers': _getWorkers
        },
        
        nav: [
            { url: '/system', title: 'System', items: navItems }
        ],

        views: {
            'system/config': path.join(viewsPath, 'config.html'),
            'system/environment': path.join(viewsPath, 'environment.html'),
            'system/workers': path.join(viewsPath, 'workers.html'),
            'system/packages': path.join(viewsPath, 'packages.html')
        }
    });
};

exports.drop = function(server, config, dash) {
    // cleanup messenger listeners
    dash.messenger.removeListener('action', _handleActions);
    
    return [
        { action: 'dropLoader', loader: 'system/config' },
        { action: 'dropLoader', loader: 'system/environment' },
        { action: 'dropLoader', loader: 'system/workers' },
        { action: 'removeNav', url: '/system' },
        { action: 'dropView', view: 'system/config' },
        { action: 'dropView', view: 'system/environment' },
        { action: 'dropView', view: 'system/workers' },
        { action: 'dropView', view: 'system/packages' }
    ];
};