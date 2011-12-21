var debug = require('debug')('dash-systools'),
    fs = require('fs'),
    path = require('path'),
    exec = require('child_process').exec,
    viewsPath = path.resolve(__dirname, '../../views'),
    _ = require('underscore'),
    _configFiles = {},
    _actionHandler,
    retrieveSize = 1024 * 16,
    logTypes = {
        'monitor.log': 'events',
        'server.log': 'events',
        'workers.log': 'events',
        'dashboard.log': 'events',
    },
    _logpath;

function _getException(req, res) {
    var exceptionId, exceptionTime, exceptionPath;

    try {
        exceptionId = parseInt(req.param('exception'), 10);
        exceptionTime = new Date(exceptionId);
    }
    catch (e) {
        res.json({ err: 'Invalid exception id' });
        return;
    }

    exceptionPath = 'exceptions/' + exceptionTime.toISOString().slice(0, 10) + '/' + exceptionId + '.json';
    fs.readFile(path.resolve(_logpath, exceptionPath), 'utf8', function(err, data) {
        if (! err) {
            try {
                res.json(JSON.parse(data));
            }
            catch (e) {
                res.json({ err: 'Invalid exception file' });
            }
        }
        else {
            res.json({ err: 'Could not read exception file: ' + exceptionPath });
        }
    });
} // getException

function _getLogLines(req, res) {
    var logType = logTypes[req.param('log')] || 'access',
        logfile = path.resolve(_logpath, req.param('log')),
        buffer = '';

    debug('attempting to get log lines for file: ' + logfile);
    fs.stat(logfile, function(err, stats) {
        if (err) {
            callback({ error: 'Not found' });
        }
        else {
            var offset = parseInt(req.param('offset', stats.size), 10),
                stream = fs.createReadStream(logfile, { start: Math.max(offset - retrieveSize, 0), end: offset });

            stream.setEncoding('utf8');
            stream.resume();

            stream.on('data', function(chunk) {
                buffer += chunk;
            });

            stream.on('end', function() {
                var newOffset = Math.max(offset - retrieveSize + buffer.indexOf('\n'), 0),
                    lines = buffer.split('\n').slice(newOffset ? 1 : 0);

                // if the order is reversed, then well, reverse the array
                if (req.param('order', 'desc') === 'desc') {
                    lines = lines.reverse();
                }

                // see if we have the log stream open
                res.json({
                    type: logType,
                    offset: newOffset,
                    size: stats.size,
                    lines: lines,
                    stats: stats
                });
            });
        }
    });
}

function _getLogs(req, page, callback) {
    fs.readdir(_logpath, function(err, files) {
        var logs = [];

        // iterate through the files
        (files || []).forEach(function(file) {
            if (path.extname(file) === '.log') {
                logs.push(file);
            }
        });

        callback({ logs: logs });
    });        
} // _getLogs

function _parseAccessLog(lines) {
    return lines;
}    
    
function _getWorkers(config, dash) {
    return function(req, page, callback) {
        // pluck the worker pids
        var activeCount = 0,
            pids = _.pluck(dash.activeWorkers, 'pid');

        debug('checking status of processes: ', pids);
        exec('ps -p ' + pids.join(',') + ' -o pid', function(err, stdout) {
            if (err) {
                debug('receieved error attempting to find processes: ' + err);
            }
            else {
                debug('got response from ps: ' + stdout);
                
                var activePids = stdout.split('\n').slice(1).map(function(item) {
                    return parseInt(item, 10);
                });
                
                // iterate through the active workers and update the active state
                (dash.activeWorkers || []).forEach(function(entry) {
                    entry.active = activePids.indexOf(entry.pid) >= 0;
                    
                    // if the entry is active, increment the active worker couhc
                    if (entry.active) {
                        activeCount++;
                    }
                    
                    // if the entry is still active, but we received a shutdown message
                    // flag a warning
                    debug('entry active = ', entry.active, ' entry shutdown = ', entry.shutdown);
                    if (entry.active && entry.shutdown) {
                        entry.status = 'warning';
                        entry.help = 'Worker active after receiving shutdown command';
                    }
                    else if ((! entry.active) && (! entry.shutdown)) {
                        entry.status = 'warning';
                        entry.help = 'Worker not active, but has not been requested to shutdown';
                    }
                    else if (entry.active && (! entry.shutdown)) {
                        entry.status = 'success';
                    }
                });
            }
            
            callback({
                activeCount: activeCount,
                workers: dash.activeWorkers || []
            });
        });
    };
}

function _makeActionHandler(config, dash) {
    // ensure the dash has active worker data
    if (! dash.activeWorkers) {
        dash.activeWorkers = [];
    }
    
    return function(msg) {
        if (msg.action) {
            debug('captured action: ', msg);

            switch (msg.action) {
                case 'worker-online': {
                    var entry = _.find(dash.activeWorkers, function(entry) {
                            return entry.pid === msg.pid;
                        });

                    // if we don't have an entry then add it to the list
                    if (! entry) {
                        dash.activeWorkers.unshift({
                            pid: parseInt(msg.pid, 10),
                            started: new Date()
                        });
                    }

                    break;
                }

                case 'shutdown': {
                    var targets = _.filter(dash.activeWorkers, function(entry) {
                            return msg.targets.indexOf(entry.pid) >= 0;
                        });
                        
                    // iterate through the targets and update the active status
                    // and shutdown time
                    targets.forEach(function(target) {
                        target.shutdown = new Date();
                    });

                    break;
                }
            }
        }        
    };
} // _makeActionHandler

function _makeDownloadLogHandler(config, dash) {
    var tarPath = 'tar',
        sourcePath = path.join(dash.serverPath, 'logs'),
        logsDownload = path.join(dash.serverPath, 'logs.tar.gz');
    
    // find tar
    exec('which tar', function(err, stdout, stderr) {
        tarPath = (stdout || '').replace(/\n/mg, '');
    });
    
    return function(req, res, next) {
        var tarCommand = tarPath + ' -czf ' + logsDownload + ' -C ' + dash.serverPath + ' logs/*';
        
        console.log(tarCommand);
        exec(tarCommand, function(err, stdout, stderr) {
            if (! err) {
                res.download(logsDownload, 'logs.tar.gz');
            }
            else {
                res.send('<html><body>Unable to create logs.tar.gz for download<hr /><pre>' + err + '</pre></body></html>');
            }
        });
    };
} // _makeDownloadLogHandler

function _makeReloadHandler(config, dash) {
    return function(req, res, next) {
        if (dash.restart) {
            dash.restart(function() {
                res.redirect('/system/config');
            });
        }
        else {
            res.redirect('/system/config');
            
            setTimeout(function() {
                exec('service steelmesh restart', function() {
                    debug('restarted');
                });
            });
        }
    };
} // _makeReloadHandler

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
    
exports.connect = function(server, config, dash) {
    var navItems = [
        { url: '/system/config', title: 'Config' },
        { url: '/system/environment', title: 'Environment' },
        { url: '/system/logs', title: 'Logs' },
        { url: '/system/workers', title: 'Workers' },
        { url: '/system/packages', title: 'Packages' }
    ];
    
    // update the log path
    _logpath = path.resolve(dash.serverPath, 'logs');
    
    // add message listeners
    dash.messenger.on('action', _actionHandler = _makeActionHandler(config, dash));
    
    // load the config files
    _loadConfigFiles(dash);
    
    // handle recycling
    server.get('/system/recycle', function(req, res, next) {
        dash.messenger.send('steelmesh-restart', { monitor: true });
        res.redirect('/system/workers');
    });
    
    server.get('/system/log/:log', _getLogLines);
    server.get('/system/exception/:exception', _getException);
    server.get('/system/config/reload', _makeReloadHandler(config, dash));
    server.get('/system/logs/download', _makeDownloadLogHandler(config, dash));
    
    // set the upload path
    return {
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
            
            'system/logs': _getLogs,
            'system/workers': _getWorkers(config, dash)
        },
        
        nav: [
            { url: '/system', title: 'System', items: navItems }
        ],

        views: {
            'system/config': path.join(viewsPath, 'config.html'),
            'system/environment': path.join(viewsPath, 'environment.html'),
            'system/logs': path.join(viewsPath, 'logs.html'),
            'system/workers': path.join(viewsPath, 'workers.html'),
            'system/packages': path.join(viewsPath, 'packages.html')
        }
    };
};

exports.drop = function(server, config, dash) {
    server.remove('/system/recycle');
    server.remove('/system/log/:log');
    server.remove('/system/exception/:exception');
    server.remove('/system/config/reload');
    server.remove('/system/logs/download');
    
    // cleanup messenger listeners
    dash.messenger.removeListener('action', _actionHandler);
    
    return [
        { action: 'removeNav', url: '/system' },
        { action: 'dropLoader', loader: 'system/config' },
        { action: 'dropLoader', loader: 'system/environment' },
        { action: 'dropLoader', loader: 'system/logs' },
        { action: 'dropLoader', loader: 'system/workers' },
        { action: 'dropView', view: 'system/config' },
        { action: 'dropView', view: 'system/environment' },
        { action: 'dropView', view: 'system/logs' },
        { action: 'dropView', view: 'system/workers' },
        { action: 'dropView', view: 'system/packages' }
    ];
};