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
import {Duplex, Readable} from 'stream';
import logger from 'electron-log';

/**
 * Base HTTP "ZitiRequest" class. Emulates the node-core `http.ClientRequest` class, but
 * does not use Socket, and instead integrates with the ziti-sdk-nodejs https_request_XXX
 * mechanisms.
 *
 * @api public
 */

class ZitiResponse extends Duplex {

    constructor(uuid) {
        super();

        this.uuid = uuid;   // debugging/tracing aid

        /**
         * This stream is where we'll put any data returned from a ZitiRequest
         */
        this.readableZitiStream = new Readable();
        this.readableZitiStream._read = function () { /* nop */ }

        /**
         * Start the async iterator on the stream.
         */
        setImmediate(this._pumpZitiStream.bind(this));
        // setTimeout(()=>this._pumpZitiStream.bind(this),0)

        /**
         *  Properties
         */
        this._headers;
        this._statusCode;
        this._statusMessage;
    }

    _read () { /* nop */ }

    /**
     * Pump all data arriving from ZitiRequest out into the stream represented by this ZitiResponse object
     */
    async _pumpZitiStream() {
        // logger.info('this._pumpZitiStream() entered: this.uuid is: %o', this.uuid);
        // Block here waiting for a chunk of data
        for await (const chunk of this.readableZitiStream) {
            // logger.info('_pumpZitiStream(): chunk received from this.readableZitiStream is: %o', chunk);

            // Push the chunk into the Duplex.  If we experience back-pressure, wait for things to drain.
            if (!this.push(chunk)) await new Promise((res, rej) => {
                // logger.info('this._pumpZitiStream() awaiting drain');
                this.once("drain", res);
            });

            // logger.info('this._pumpZitiStream() chunk successfully pumped');
        }
    }

    
    /**
     * 
     */
    async _pushData(buffer) {

        // logger.info('_pushData(): uuid: %o, buf is: %o', this.uuid, buffer);

        if (buffer) {
            this.readableZitiStream.push(buffer);
        } else {
            this.push(null);
        }
    }


    /**
     *  Properties
     */
    get headers() {
        return this._headers;
    }
    set headers(headers) {
        this._headers = headers;
    }
    get statusCode() {
        return this._statusCode;
    }
    set statusCode(statusCode) {
        this._statusCode = statusCode;
    }
    get statusMessage() {
        return this._statusMessage;
    }
    set statusMessage(statusMessage) {
        this._statusMessage = statusMessage;
    }
    
    /**
     * 
     */
    setTimeout(msecs, callback) {
        if (callback)
            this.on('timeout', callback);
        return this;
    }

    /**
     * 
     */
    destroy(error) {
    }

      
}


/**
 * Module exports.
 */

export default ZitiResponse;
