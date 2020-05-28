/*
Copyright 2019-2020 Netfoundry, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {EventEmitter} from 'events';
import logger from 'electron-log';
import { v4 as uuidv4 } from 'uuid';
import ZitiResponse from './ziti-response';
// import Headers, { createHeadersLenient } from './headers';

const UV_EOF = -4095;

/**
 * Base HTTP "ZitiRequest" class. Emulates the node-core `http.ClientRequest` class, but
 * does not use Socket, and instead integrates with the ziti-sdk-nodejs https_request_XXX
 * mechanisms.
 *
 * @api public
 */

class ZitiRequest extends EventEmitter {

    constructor(opts) {
        super();

        this.uuid = uuidv4();   // debugging/tracing aid

        /**
         * 
         */
        this.opts = opts;


        /**
         * The underlying Ziti HTTP Request (i.e. the um_http_req_t returned from Ziti_http_request() in the ziti-sdk-NodeJS )
         */
        this.ziti_http_request;

        /**
         * This response is where we'll put any data returned from a um_http_req_t
         */
        this.response = new ZitiResponse(this.uuid);

        /**
         *  Properties
         */
        this._writable = true;

    }


    /**
     *  Properties
     */
    get writable() {
        return this._writable;
    }
    set writable(writable) {
        this._writable = writable;
    }


    /**
     * Initiate an HTTPS request.  We do this by invoking the Ziti_http_request() function in the Ziti NodeJS-SDK.
     * @param {*} url 
     * @param {*} method 
     * @param {*} headers 
     */
    async do_Ziti_http_request(url, method, headers) {
        const self = this;
        return new Promise((resolve, reject) => {
            try {
        
                // logger.info('TRANSMITTING: req uuid: %o \nmethod: %s \nurl: %s \nheaders: %0', this.uuid, method, url, headers);

                let req = window.ziti.Ziti_http_request(
                    url,
                    method,
                    headers,

                    // on_resp callback
                    (obj) => {

                        // logger.info('TRANSMITTING (on_resp callback): req uuid: %o \nobj: %0', this.uuid, obj);

                        // Set properties
                        this.response.headers = obj.headers;
                        this.response.statusCode = obj.code;
                        this.response.statusMessageCode = obj.status;

                        // logger.info('on_resp callback emitting resp: %o', this.response);

                        this.emit('response', this.response);

                    },

                    // on_resp_body callback
                    (obj) => {

                        // logger.info('TRANSMITTING (on_resp_body callback): req uuid: %o \nobj: %0', this.uuid, obj);

                        //
                        //  REQUEST COMPLETE 
                        //
                        if (obj.len === UV_EOF) {
                            // logger.info('REQUEST COMPLETE');
                            this.response._pushData(null);
                            this.response.emit('close');
                        }

                        //
                        //  ERROR 
                        //
                        else if (obj.len < 0) {
                            let err = this.requestException(obj.len);
                            logger.error('on_resp_body callback emitting error: %o', err);
                            this.emit('error', err);
                        }

                        //
                        // DATA RECEIVED
                        //
                        else {

                            if (obj.body) {

                                const buffer = Buffer.from(obj.body);

                                // logger.info('DATA RECEIVED: body is: \n%s', buffer.toString());
                            
                                this.response._pushData(buffer);

                            } else {

                                logger.error('DATA RECEIVED: but body is undefined!');

                            }
                        }

                    },
                );
    
                // logger.info('req is (%o)', req);
                resolve(req);
    
            }
            catch (e) {
                reject(e);
            }
        });
    }


    /**
     *  Initiate the HTTPS request
     */
    async start() {

        let headersArray = [];

        for (var key of Object.keys(this.opts.headers)) {
            let hdr
            if (key === 'Cookie') {
                let value = '';
                this.opts.headers[key].forEach(element => {
                    if (value.length > 0) {
                        value += ';';
                    }
                    value += element;
                });
                hdr = key + ':' + value;
            } else {
                hdr = key + ':' + this.opts.headers[key];
            }
            headersArray.push(hdr);
        }
        
        this.ziti_http_request = await this.do_Ziti_http_request(

            this.opts.href,
            this.opts.method,
            headersArray

        ).catch((e) => {
            logger.error('Error: ', e.message);
        });

    }
    
    /**
     * 
     */
    end(chunk, encoding, callback) {

        // logger.info('req.end() for: uuid: %o', this.uuid);

        window.ziti.Ziti_http_request_end( this.ziti_http_request );
      
        return this;
    };
    
    
    /**
     * Send a request body chunk.  We do this by invoking the Ziti_http_request_data() function in the Ziti NodeJS-SDK.
     * @param {*} req 
     * @param {*} buffer 
     */
    async do_Ziti_http_request_data(req, buffer) {
        const self = this;
        return new Promise((resolve, reject) => {
            try {
    
                // logger.info('SEND request_data for req uuid: %o, data (%o)', this.uuid, buffer);
    
                window.ziti.Ziti_http_request_data(
                    req,
                    buffer,

                    // on_req_body callback
                    (obj) => {

                        // logger.info('on_req_body, obj: %o', obj);

                        //
                        //  ERROR 
                        //
                        if (obj.status < 0) {
                            logger.error('obj.status === ERROR');
                            reject(this.requestException(obj.status));
                        }

                        //
                        // SUCCESSFUL TRANSMISSION
                        //
                        else {
                            // logger.info('DATA TRAMSMITTED for req uuid: %o', this.uuid);

                            resolve(obj);
                        }
                    }
                );
            }
            catch (e) {
                reject(e);
            }
        });
    }


    /**
     * Send a request body chunk.
     */
    async write(chunk, encoding, callback) {

        let buffer;

        if (typeof chunk === 'string' || chunk instanceof String) {
            buffer = Buffer.from(chunk, 'utf8');
        } else if (Buffer.isBuffer(chunk)) {
            buffer = chunk;
        } else {
            throw new Error('chunk type of [' + typeof chunk + '] is not a supported type');
        }
        
        // logger.info('req.write() for: uuid: %o \ndata (%o)\nstring-fied (%s)', this.uuid, buffer, buffer.toString());

        let obj = await this.do_Ziti_http_request_data(

            this.ziti_http_request,
            buffer

        ).catch((e) => {
            logger.error('Error: %o', e);
            this.emit('error', e);
        });

        // logger.info('req.write() back from call to do_Ziti_http_request_data for: uuid: %o', this.uuid);

    }


    /**
     * 
     */
    requestException(num) {
        const ex = new Error('HTTPS Request failed; code ['+num+']');
        ex.code = 'EREQUEST';
        return ex;
    }
      
}


/**
 * Module exports.
 */

export default ZitiRequest;
