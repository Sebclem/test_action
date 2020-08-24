const { createClient } = require("webdav");
const fs = require("fs");
const moment = require('moment');

const statusTools = require('./status');
const endpoint = "/remote.php/webdav";
const configPath = "/data/webdav_conf.json";
const path = require('path');
const settingsTools = require('./settingsTools');
const pathTools = require('./pathTools');
const hassioApiTools = require('./hassioApiTools');
const logger = require('../config/winston');

const got = require ('got');

class WebdavTools {
    constructor() {
        this.client = null;
        this.baseUrl = null;
        this.username = null;
        this.password = null;
    }
    
    init(ssl, host, username, password) {
        return new Promise((resolve, reject) => {
            let status = statusTools.getStatus();
            logger.info("Initilizing and checking webdav client...");
            this.baseUrl = (ssl === "true" ? "https" : "http") + "://" + host + endpoint;
            this.username = username;
            this.password = password;
            try {
                this.client = createClient(this.baseUrl, { username: username, password: password });
                
                this.client.getDirectoryContents("/").then(() => {
                    if (status.error_code == 3) {
                        status.status = "idle";
                        status.message = null;
                        status.error_code = null;
                        statusTools.setStatus(status);
                    }
                    logger.debug("Nextcloud connection:  \x1b[32mSuccess !\x1b[0m");
                    this.initFolder().then(() => {
                        resolve();
                    });
                    
                }).catch((error) => {
                    status.status = "error";
                    status.error_code = 3;
                    status.message = "Can't connect to Nextcloud (" + error + ") !"
                    statusTools.setStatus(status);
                    this.client = null;
                    logger.error("Can't connect to Nextcloud (" + error + ") !");
                    reject("Can't connect to Nextcloud (" + error + ") !");
                });
            } catch (err) {
                status.status = "error";
                status.error_code = 3;
                status.message = "Can't connect to Nextcloud (" + err + ") !"
                statusTools.setStatus(status);
                this.client = null;
                logger.error("Can't connect to Nextcloud (" + err + ") !");
                reject("Can't connect to Nextcloud (" + err + ") !");
            }
            
        });
    }
    
    initFolder() {
        return new Promise((resolve, reject) => {
            this.client.createDirectory(pathTools.root).catch(() => { }).then(() => {
                this.client.createDirectory(pathTools.auto).catch(() => { }).then(() => {
                    this.client.createDirectory(pathTools.manual).catch(() => { }).then(() => {
                        resolve();
                    })
                })
            });
        });
        
    }
    
    confIsValid() {
        return new Promise((resolve, reject) => {
            let status = statusTools.getStatus();
            let conf = this.getConf();
            if (conf !== null) {
                if (conf.ssl !== null && conf.host !== null && conf.username !== null && conf.password !== null) {
                    if (status.error_code == 2) {
                        status.status = "idle";
                        status.message = null;
                        status.error_code = null;
                        statusTools.setStatus(status);
                    }
                    this.init(conf.ssl, conf.host, conf.username, conf.password).then(() => {
                        resolve();
                    }).catch((err) => {
                        reject(err);
                    });
                    
                }
                else {
                    status.status = "error";
                    status.error_code = 2;
                    status.message = "Nextcloud config invalid !"
                    statusTools.setStatus(status);
                    logger.error(status.message);
                    reject("Nextcloud config invalid !");
                }
            }
            else {
                status.status = "error";
                status.error_code = 2;
                status.message = "Nextcloud config not found !"
                statusTools.setStatus(status);
                logger.error(status.message);
                reject("Nextcloud config not found !");
            }
            
        });
    }
    
    getConf() {
        if (fs.existsSync(configPath)) {
            let content = JSON.parse(fs.readFileSync(configPath));
            return content;
        }
        else
        return null;
    }
    
    setConf(conf) {
        fs.writeFileSync(configPath, JSON.stringify(conf));
    }
    
    
    uploadFile(id, path) {
        return new Promise((resolve, reject) => {
            if (this.client == null) {
                this.confIsValid().then(() => {
                    this._startUpload(id, path);
                }).catch((err) => {
                    reject(err);
                })
            }
            else
            this._startUpload(id, path);
        });
    }
    
    _startUpload(id, path) {
        return new Promise( async (resolve, reject) => {
            let status = statusTools.getStatus();
            status.status = "upload";
            status.progress = 0;
            status.message = null;
            status.error_code = null;
            statusTools.setStatus(status);
            logger.info('Uploading snap...');
            let tmpFile = `./temp/${id}.tar`
            let fileSize = fs.statSync(tmpFile).size;
            let stream =  fs.createReadStream(tmpFile);
            
            let options = {
                body: stream,
                username: this.username,
                password: this.password
            }
            
            got.stream.put(this.baseUrl + encodeURI(path), options).on('uploadProgress', e => {
                let percent = e.percent;
                if (status.progress != percent) {
                    status.progress = percent;
                    statusTools.setStatus(status);
                }
                if (percent >= 1) {
                    logger.info('Upload done...');
                }
            }).on('response', res => {
                
                if (res.statusCode != 201 && res.statusCode != 204) {
                    status.status = "error";
                    status.error_code = 4;
                    status.message = `Fail to upload snapshot to nextcloud (Status code: ${res.statusCode})!`;
                    statusTools.setStatus(status);
                    logger.error(status.message);
                    fs.unlinkSync(tmpFile);
                    reject(status.message);
                } else {
                    logger.info(`...Upload finish ! (status: ${res.statusCode})`);
                    status.status = "idle";
                    status.progress = -1;
                    status.message = null;
                    status.error_code = null;
                    status.last_backup = moment().format('MMM D, YYYY HH:mm');
                    statusTools.setStatus(status);
                    cleanTempFolder();
                    let autoCleanCloud = settingsTools.getSettings().auto_clean_backup;
                    if (autoCleanCloud != null && autoCleanCloud == "true") {
                        this.clean().catch();
                    }
                    let autoCleanlocal = settingsTools.getSettings().auto_clean_local;
                    if (autoCleanlocal != null && autoCleanlocal == "true") {
                        hassioApiTools.clean();
                    }
                    resolve();
                }
            }).on('error', err => {
                
                fs.unlinkSync(tmpFile);
                status.status = "error";
                status.error_code = 4;
                status.message = `Fail to upload snapshot to nextcloud (${err}) !`;
                statusTools.setStatus(status);
                logger.error(status.message);
                reject(status.message);
            });
            
        });
    }
    
    getFolderContent(path) {
        return new Promise((resolve, reject) => {
            if(this.client == null){
                reject();
                return;
            }
            this.client.getDirectoryContents(path)
            .then((contents) => {
                resolve(contents);
            }).catch((error) => {
                reject(error);
            })
        });
    }
    
    clean() {
        let limit = settingsTools.getSettings().auto_clean_local_keep;
        if (limit == null)
        limit = 5;
        return new Promise((resolve, reject) => {
            this.getFolderContent(pathTools.auto).then(async (contents) => {
                if (contents.length < limit) {
                    resolve();
                    return;
                }
                contents.sort((a, b) => {
                    if (moment(a.lastmod).isBefore(moment(b.lastmod)))
                    return 1;
                    else
                    return -1;
                });
                
                let toDel = contents.slice(limit);
                for (let i in toDel) {
                    await this.client.deleteFile(toDel[i].filename);
                }
                logger.info('Cloud clean done.')
                resolve();
                
            }).catch((error) => {
                status.status = "error";
                status.error_code = 6;
                status.message = "Fail to clean Nexcloud (" + error + ") !"
                statusTools.setStatus(status);
                logger.error(status.message);
                reject(status.message);
            });
        })
        
    }
    
    
    
    
}

function cleanTempFolder() {
    fs.readdir("./temp/", (err, files) => {
        if (err) throw err;
        
        for (const file of files) {
            fs.unlink(path.join("./temp/", file), err => {
                if (err) throw err;
            });
        }
    });
}


class Singleton {
    constructor() {
        if (!Singleton.instance) {
            Singleton.instance = new WebdavTools();
        }
    }
    
    getInstance() {
        return Singleton.instance;
    }
}

module.exports = Singleton;

