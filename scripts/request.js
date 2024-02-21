import http from 'node:http'
import https from 'node:https'
import url from 'url'

const DEFAULT_HEADERS = {
    'User-Agent': 'rss-parser',
    'Accept': 'application/rss+xml',
}
const MAX_REDIRECT = 5
const DEFAULT_TIMEOUT = 10000

const httpRequest = async (feedUrl, redirectCount=0, options={}) => {
    let xml = '';
    let get = feedUrl.indexOf('https') === 0 ? https.get : http.get;
    let urlParts = new url.parse(feedUrl);
    let headers = Object.assign({}, DEFAULT_HEADERS, options.headers);

    if (options?.etags?.[feedUrl]) {
        headers['If-None-Match'] = options?.etags?.[feedUrl];
    }

    if (options?.lastModified?.[feedUrl]) {
        headers['If-Modified-Since'] = options?.lastModified?.[feedUrl];
    }

    let timeout = null;
    let prom = new Promise((resolve, reject) => {
        const requestOpts = Object.assign({headers}, urlParts, options.requestOptions);
        let req = get(requestOpts, (res) => {

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers['location']) {
            if (redirectCount === MAX_REDIRECT) {
            return reject(new Error("Too many redirects"));
            } else {
            const newLocation = url.resolve(feedUrl, res.headers['location']);
            return httpRequest(newLocation, redirectCount + 1).then(resolve, reject);
            }
        } else if (res.statusCode === 304) {
            return resolve(null);
        } else if (res.statusCode >= 300) {
            return reject(new Error("Status code " + res.statusCode));
        }

        if (res.headers['etag']) {
            if (!options.etags) options.etags = {}
            options.etags[feedUrl] = res.headers['etag'];
        }

        if (res.headers['last-modified']) {
            if (!options.lastModified) options.lastModified = {}
            options.lastModified[feedUrl] = res.headers['last-modified'];
        }

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            xml += chunk;
        });
        res.on('end', () => {
            return resolve(xml);
        });
        })

        req.on('error', reject);

        timeout = setTimeout(() => {
            return reject(new Error("Request timed out after " + (options.timeout ?? DEFAULT_TIMEOUT) + "ms"));
        }, options.timeout ?? DEFAULT_TIMEOUT);
    }).then(data => {
        clearTimeout(timeout);
        return Promise.resolve(data);
    }, e => {
        clearTimeout(timeout);
        return Promise.reject(e);
    });
    return prom;
}

export default httpRequest
