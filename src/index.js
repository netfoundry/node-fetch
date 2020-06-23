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

/**
 * index.js
 *
 * a request API compatible with window.fetch
 *
 * All spec algorithm step numbers are based on https://fetch.spec.whatwg.org/commit-snapshots/ae716822cb3a61843226cd090eefc6589446c1d2/.
 */

import Url from 'url';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import Stream from 'stream';
import log from 'electron-log';

log.info('ziti-electron-fetch LOADED');

import Body, { writeToStream, getTotalBytes } from './body';
import Response from './response';
import Headers, { createHeadersLenient } from './headers';
import Request, { getNodeRequestOptions } from './request';
import FetchError from './fetch-error';
import FetchLocation from './fetch-location';
import AbortError from './abort-error';
import {remote} from 'electron';
import SessionCookies from './session-cookies';
import FormData from './form-data';
import XMLHttpRequest from './XMLHttpRequest';
import ZitiRequest from './ziti-request';
import {Mutex} from 'async-mutex';

const shutdownMutex = new Mutex();

let ziti
try {
	log.info('about to load ziti-sdk-nodejs');
	ziti = require('ziti-sdk-nodejs');
	log.info('ziti is: %o', ziti);
	require('assert').equal(ziti.ziti_hello(),"ziti");
	log.info('ziti.ziti_hello says: %s', ziti.ziti_hello());
}
catch (e) {
	log.error(e);
}

const session = remote.session.defaultSession;

try {
window.realFetch = window.fetch;
window.ziti = ziti;

window.realFormData = window.FormData;
window.FormData = FormData;
window.realXMLHttpRequest = window.XMLHttpRequest;
window.XMLHttpRequest = XMLHttpRequest;
window.ZitiFetchLocation = new FetchLocation(location);
}
catch (e) {
	log.error(e);
	debugger
}

const SESSION_COOKIES = new SessionCookies();

// fix an issue where "format", "parse" aren't a named export for node <10
const parse_url = Url.parse;

/**
 * Update our cookie cache when Electron informs us of changes.
 *
 */
session.cookies.on('changed', (event, cookie, _ /*cause*/, removed) => {
	if (SESSION_COOKIES.get(cookie.name)) {
		if (removed) {
			SESSION_COOKIES.delete(cookie);
		} else {
			if (SESSION_COOKIES.getValue(cookie) === cookie.value) {
				// Nothing to do in this case
			} else {
				SESSION_COOKIES.put(cookie);
			}
		}
	} else {
		SESSION_COOKIES.put(cookie);
	}
});


/**
 * Update our cookie cache when we see set-cookie headers in HTTP responses
 *
 */
async function captureCookies(url, headers) {

	const parsedURL = parse_url(url);
  
	const setCookieHeaders = headers.raw()['Set-Cookie'];
	  
	if (setCookieHeaders) {
		setCookieHeaders.forEach(async (element) => {
			if (session) {
		  		const pieces = element.split(/=(.+)/);
		  		const cookieName = pieces[0];
		  		let cookieValue = pieces[1];
		  		const cookieValuePieces = cookieValue.split(/;(.+)/);
		  		cookieValue = cookieValuePieces[0];
		  		const expiration = new Date();
		  		expiration.setHours(expiration.getHours() + (24 * 90));
		  		let httpOnlyFlag = false;
		  		if (cookieName === 'MMAUTHTOKEN') {
					httpOnlyFlag = true;
		  		}
		  		const cookie = {
					url: parsedURL.protocol + '//' + parsedURL.hostname,
					name: cookieName,
					value: cookieValue,
					domain: parsedURL.hostname,
					path: '/',
					secure: true,
					httpOnly: httpOnlyFlag,
					expirationDate: expiration.getTime(),
		  		};
				SESSION_COOKIES.put(cookie);
				await session.cookies.set(cookie).catch((e) => log.error('session.cookies.set() Error: ', e.message));
			}
	  	});
	  	await session.cookies.flushStore().catch((e) => log.error('session.cookies.flushStore() Error: ', e.message));
	}
}
  
// fix an issue where "PassThrough", "resolve" aren't a named export for node <10
const PassThrough = Stream.PassThrough;
const resolve_url = Url.resolve;


/**
 * Perform Ziti shutdown (disconnect with Ziti Controller)
 *
 * @return  Promise
 */
async function ziti_shutdown() {
	return new Promise( async (resolve, reject) => {
		
		log.info('ziti_shutdown entered');

		if (window.zitiInitialized) {
			log.info('CALLING ziti.ziti_shutdown()');
			window.ziti.ziti_shutdown();
			window.zitiInitialized = false;
		}

		log.info('ziti_shutdown exiting');
		resolve();
	});
}

/**
 * Perform a synchronous, mutex-protected, Ziti shutdown. 
 * We only want to shutdown once, so we protect the call to the 
 * Ziti Controller behind a mutex.
 *
 * @return  Boolean
 */
async function doZitiShutdown() {
	log.info('doZitiShutdown entered');
	const release = await shutdownMutex.acquire();
	try {
		if (window.zitiInitialized) {
			await ziti_shutdown().catch((e) => {
				log.error('ziti_shutdown exception: ' + e);
				return;
			});
			window.zitiInitialized = false;
		}
	} finally {
		release();
	}
	log.info('doZitiShutdown exiting');
}

/**
 * Fetch function
 *
 * @param   Mixed    url   Absolute url or Request instance
 * @param   Object   opts  Fetch options
 * @return  Promise
 */
export default function fetch(url, opts) {

	// log.info('fetch() \nurl: %s \nopts: %o', url, opts);

	// allow custom promise
	if (!fetch.Promise) {
		throw new Error('native promise missing, set fetch.Promise to your favorite alternative');
	}

	if (/^data:/.test(url)) {
		const request = new Request(url, opts, SESSION_COOKIES);
		try {
			const data = Buffer.from(url.split(',')[1], 'base64')
			const res = new Response(data.body, { headers: { 'Content-Type': data.mimeType || url.match(/^data:(.+);base64,.*$/)[1] } });
			return fetch.Promise.resolve(res);
		} catch (err) {
			return fetch.Promise.reject(new FetchError(`[${request.method}] ${request.url} invalid URL, ${err.message}`, 'system', err));
		}
	}

	Body.Promise = fetch.Promise;

	// wrap http.request into fetch
	return new fetch.Promise(async(resolve, reject) => {
		// build request object
		const request = new Request(url, opts, SESSION_COOKIES);
		const options = await getNodeRequestOptions(request);

		const send = (options.protocol === 'https:' ? https : http).request;

		const { signal } = request;
		let response = null;

		const abort = ()  => {
			let error = new AbortError('The user aborted a request.');
			reject(error);
			if (request.body && request.body instanceof Stream.Readable) {
				request.body.destroy(error);
			}
			if (!response || !response.body) return;
			response.body.emit('error', error);
		}

		if (signal && signal.aborted) {
			abort();
			return;
		}

		const abortAndFinalize = () => {
			abort();
			finalize();
		}

		let req;

		/**
		 * 	Send over Ziti only if the target host name matches an active Ziti Service...
		 */
		if (request.hasActiveZitiService) {

			// log.info('ZITIFYd send \nurl: %s\nheaders: %o', options.href, options.headers);
			req = new ZitiRequest(options);
			await req.start();
	
		} 
		else {	// ... otherwise route over raw internet
			// log.info('BYPASSing: %o', options);
			req = send(options);

		}

		let reqTimeout;

		if (signal) {
			signal.addEventListener('abort', abortAndFinalize);
		}

		function finalize() {
			req.abort();
			if (signal) signal.removeEventListener('abort', abortAndFinalize);
			clearTimeout(reqTimeout);
		}

		if (request.timeout) {
			req.once('socket', socket => {
				reqTimeout = setTimeout(() => {
					reject(new FetchError(`network timeout at: ${request.url}`, 'request-timeout'));
					finalize();
				}, request.timeout);
			});
		}

		req.on('error', err => {
			log.error('error EVENT: err: %o', err);
			reject(new FetchError(`request to ${request.url} failed, reason: ${err.message}`, 'system', err));
			finalize();
		});

		req.on('response', async res => {

			if (res.statusCode < 0) {	// Ziti error?
				log.error('req.on[response] \nrequest.url: %s \nres.statusCode is: %o', request.url, res.statusCode);

				doZitiShutdown();

				reject(new FetchError(`request to ${request.url} failed, code: ${res.statusCode}`, 'system'));
				finalize();
				return;	
			}

			clearTimeout(reqTimeout);

			const headers = createHeadersLenient(res.headers);

			captureCookies(request.url, headers);

			// HTTP fetch step 5
			if (fetch.isRedirect(res.statusCode)) {
				// HTTP fetch step 5.2
				const location = headers.get('Location');

				// HTTP fetch step 5.3
				const locationURL = location === null ? null : resolve_url(request.url, location);

				// HTTP fetch step 5.5
				switch (request.redirect) {
					case 'error':
						reject(new FetchError(`uri requested responds with a redirect, redirect mode is set to error: ${request.url}`, 'no-redirect'));
						finalize();
						return;
					case 'manual':
						// node-fetch-specific step: make manual redirect a bit easier to use by setting the Location header value to the resolved URL.
						if (locationURL !== null) {
							// handle corrupted header
							try {
								headers.set('Location', locationURL);
							} catch (err) {
								// istanbul ignore next: nodejs server prevent invalid response headers, we can't test this through normal request
								reject(err);
							}
						}
						break;
					case 'follow':
						// HTTP-redirect fetch step 2
						if (locationURL === null) {
							break;
						}

						// HTTP-redirect fetch step 5
						if (request.counter >= request.follow) {
							reject(new FetchError(`maximum redirect reached at: ${request.url}`, 'max-redirect'));
							finalize();
							return;
						}

						// HTTP-redirect fetch step 6 (counter increment)
						// Create a new Request object.
						const requestOpts = {
							headers: new Headers(request.headers),
							follow: request.follow,
							counter: request.counter + 1,
							agent: request.agent,
							compress: request.compress,
							method: request.method,
							body: request.body,
							signal: request.signal,
							timeout: request.timeout
						};

						// HTTP-redirect fetch step 9
						if (res.statusCode !== 303 && request.body && getTotalBytes(request) === null) {
							reject(new FetchError('Cannot follow redirect with body being a readable stream', 'unsupported-redirect'));
							finalize();
							return;
						}

						// HTTP-redirect fetch step 11
						if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && request.method === 'POST')) {
							requestOpts.method = 'GET';
							requestOpts.body = undefined;
							requestOpts.headers.delete('content-length');
						}

						// HTTP-redirect fetch step 15
						resolve(fetch(new Request(locationURL, requestOpts, SESSION_COOKIES)));
						finalize();
						return;
				}
			}

			// prepare response
			res.once('end', () => {
				if (signal) signal.removeEventListener('abort', abortAndFinalize);
			});
			let body = res.pipe(new PassThrough());

			const response_options = {
				url: request.url,
				status: res.statusCode,
				statusText: res.statusMessage,
				headers: headers,
				size: request.size,
				timeout: request.timeout,
				counter: request.counter
			};

			// HTTP-network fetch step 12.1.1.3
			const codings = headers.get('Content-Encoding');

			// HTTP-network fetch step 12.1.1.4: handle content codings

			// in following scenarios we ignore compression support
			// 1. compression support is disabled
			// 2. HEAD request
			// 3. no Content-Encoding header
			// 4. no content response (204)
			// 5. content not modified response (304)
			if (!request.compress || request.method === 'HEAD' || codings === null || res.statusCode === 204 || res.statusCode === 304) {
				response = new Response(body, response_options);
				resolve(response);
				return;
			}

			// For Node v6+
			// Be less strict when decoding compressed responses, since sometimes
			// servers send slightly invalid responses that are still accepted
			// by common browsers.
			// Always using Z_SYNC_FLUSH is what cURL does.
			const zlibOptions = {
				flush: zlib.Z_SYNC_FLUSH,
				finishFlush: zlib.Z_SYNC_FLUSH
			};

			// for gzip
			if (codings == 'gzip' || codings == 'x-gzip') {
				body = body.pipe(zlib.createGunzip(zlibOptions));
				response = new Response(body, response_options);
				resolve(response);
				return;
			}

			// for deflate
			if (codings == 'deflate' || codings == 'x-deflate') {
				// handle the infamous raw deflate response from old servers
				// a hack for old IIS and Apache servers
				const raw = res.pipe(new PassThrough());
				raw.once('data', chunk => {
					// see http://stackoverflow.com/questions/37519828
					if ((chunk[0] & 0x0F) === 0x08) {
						body = body.pipe(zlib.createInflate());
					} else {
						body = body.pipe(zlib.createInflateRaw());
					}
					response = new Response(body, response_options);
					resolve(response);
				});
				return;
			}

			// for br
			if (codings == 'br' && typeof zlib.createBrotliDecompress === 'function') {
				body = body.pipe(zlib.createBrotliDecompress());
				response = new Response(body, response_options);
				resolve(response);
				return;
			}

			// otherwise, use response as-is
			response = new Response(body, response_options);
			resolve(response);
		});

		writeToStream(req, request);
	});

};

/**
 * Redirect code matching
 *
 * @param   Number   code  Status code
 * @return  Boolean
 */
fetch.isRedirect = code => code === 301 || code === 302 || code === 303 || code === 307 || code === 308;

window.fetch = fetch;

// expose Promise
fetch.Promise = global.Promise;
export {
	Headers,
	Request,
	Response,
	FetchError,
	FetchLocation
};
