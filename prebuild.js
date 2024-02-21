"use strict";

import _ from 'lodash'
import consola from 'consola'
import 'date-utils'
import fetchTwitter from './scripts/fetch-twitter.js'
import fileExtension from 'file-extension'
import fs from 'fs'
import moment from 'moment'
import nodeCleanup from 'node-cleanup'
import PFUtil from './scripts/pf-util.js'
import rss from './data/rss.json' assert { type: 'json' }
import {serializeError} from 'serialize-error'
import shell from 'shelljs'
import pkg from 'sleep';
const { sleep } = pkg;
import wget from 'node-wget-promise'
import { XMLParser } from "fast-xml-parser";
const parser = new XMLParser();

import { promisify } from 'util'
import {
  RFC822,
  DOWNLOADS_DIR,
  RSS_DIR,
  COVER_DIR,
  BUILD_INFO
} from './scripts/constants.js'
import httpRequest from './scripts/request.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

// ----------------
// Detect arguments
const args = process.argv.slice() // copy
args.splice(0, 2) // remove not 'arg' values

// CLI arguments list
const NO_TWITTER = args.includes('--no-twitter') // to cancel twitter data fetching
// ----------------

const util = new PFUtil()
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)

let episodes_in_2weeks = []
let latest_pubdates = []
let channels = {}
let covers = {}
let episodeCount = 0
let errors = []
let downloads_backup = null

const error = function(label, rss, error){
  if(error) {
    console.error(`${label} | ${rss} | ${error} | ${error.stack}`)
    errors.push({label, rss, error: serializeError(error)})
  }
  else {
    console.error(`${label} | ${rss}`)
    errors.push({label, rss})
  }

}

process.on('unhandledRejection', console.dir)

const fetchFeed = async key => {
  const src = rss[key].feed
  let dist_rss = null

  // Handling errors

  //------------------

  // Download RSS (try 3 times)
  const retryCount = 1
  for (let triesCounter = 0; triesCounter < retryCount; ++triesCounter) {
    try {
      dist_rss = await httpRequest(src)
      break
    } catch (e) {
      error('wget', key, e)
      console.error(e.stack)
      if (triesCounter === retryCount - 1) return
      await sleep(2)
    }
  }

  let json = null
  try {
    json = await parser.parse(dist_rss)
  } catch (e) {
    console.error(key)
    console.error(e)
    console.error(e.stack)
    return
  }

  if (!json.rss) {
    console.log(key, json)
    return
  }

  // json.rss.channel.item must be Array
  if(!(json.rss.channel.item instanceof Array)) {
    json.rss.channel.item = [json.rss.channel.item]
  }

  // Get cover image urls
  const cover_url = util.removeQuery(_.get(json, 'rss.channel[itunes:image].$.href') || _.get(json, 'rss.channel[itunes:image].href') || _.get(json, 'rss.channel.image.url'))
  if(cover_url){
    covers[key] = {
      src: cover_url,
      dist: `${COVER_DIR}/${key}.${fileExtension(cover_url)}`
    }
  }

  const channel = json.rss.channel
  const episodes = channel.item
  const title = channel.title

  // count episodes
  episodeCount += episodes.length // TODO ここではなく、必要になる所で計測して依存関係を切る

  // Get the latest episode's publish date
  latest_pubdates.push({
    id: key,
    pubDate: episodes.pubDate
  })

  episodes_in_2weeks = episodes_in_2weeks.concat(util.getEpisodesIn2Weeks(episodes, key, title))

  // Save data
  channels[key] = {
    key,
    title,
    twitter: rss[key].twitter,
    feed: rss[key].feed,
    link: channel.link ? channel.link : null,
    hashtag: rss[key].hashtag,
    cover: covers[key] ? covers[key].dist.replace(/^static/,'') : null,
    total: episodes.length,
    firstEpisodeDate: moment(_.last(episodes).pubDate, RFC822).format(moment.HTML5_FMT.DATETIME_LOCAL_SECONDS),
    lastEpisodeDate: moment(_.first(episodes).pubDate, RFC822).format(moment.HTML5_FMT.DATETIME_LOCAL_SECONDS),
    firstEpisodeLink: _.last(episodes).link,
    lastEpisodeLink: _.first(episodes).link,
    recentEpisodes: _.take(episodes, 5),
    fileServer: util.getFileServer(episodes),
    durationAverage: util.getDurationAverage(episodes, key),
    durationMedian: util.getDurationMedian(episodes, key),
    desciprtion: channel.description ? channel.description : null
  }
}

(async () => {
  // Make sure parent dir existence and its clean
  try {
    await readFile(BUILD_INFO)
    downloads_backup = `${DOWNLOADS_DIR}(backup ${new Date().toFormat('YYYYMMDD-HH24MISS')})/`
    shell.mv(`${DOWNLOADS_DIR}/`, downloads_backup)
    shell.mkdir('-p', RSS_DIR)
    shell.mkdir('-p', COVER_DIR)
    consola.log(`-> Create backup to ${downloads_backup}`)
  } catch (err) {
    shell.rm('-rf', DOWNLOADS_DIR)
    shell.mkdir('-p', RSS_DIR)
    shell.mkdir('-p', COVER_DIR)
  }


  // Parallel Execution https://qiita.com/jkr_2255/items/62b3ee3361315d55078a
  for (const keys of _(rss).keys().chunk(20)) {
    await Promise.all(keys.map(async key => await fetchFeed(key))).catch((err) => { error('fetchFeed', err) })
  }

  if(!NO_TWITTER){
    consola.log('Start fetching twitter data...')
    const accounts = {}
    for(let key in rss) {
      if(rss[key]){
        if(rss[key].twitter) {
          accounts[key] = {
            twitter: rss[key].twitter.replace('@','')
          }
        }
        if(rss[key].hashtag) {
          if(!accounts[key]) {
            accounts[key] = {}
          }
          accounts[key]['hashtag'] = rss[key].hashtag
        }
      }
    }
    const twitterData = await fetchTwitter(accounts)
    for(let key in twitterData) {
      // Ignore if key is not exist in channels (maybe it couldn't get with error)
      if(channels[key]){
        for(let prop in twitterData[key]){
          channels[key][prop] = twitterData[key][prop]
        }
      }
    }
  }

  consola.log('Export to list file ordered by pubDate')
  latest_pubdates.sort(function(a, b) {
    return new Date(b.pubDate) - new Date(a.pubDate)
  })
  episodes_in_2weeks.sort(function(a, b) {
    return new Date(b.pubDate) - new Date(a.pubDate)
  })
  const load_order = latest_pubdates.map(function(element, index, array) {
    return element.id;
  });

  consola.log('Download cover images serially to avoid 404')
  for(let key of Object.keys(covers)) await util.downloadAndResize(key, covers[key].src, covers[key].dist)

  const data = {
    load_order,
    episodes_in_2weeks,
    channels,
    updated: new Date(),
    episodeCount,
    errors
  }

  // Save to file
  await writeFile(BUILD_INFO, JSON.stringify(data), 'utf8')
})();

nodeCleanup(function (exitCode, signal) {
  if (signal == 'SIGINT' && downloads_backup) {
    consola.log(`-> Restore from backup`)
    shell.rm('-rf', DOWNLOADS_DIR)
    shell.mv(downloads_backup, `${DOWNLOADS_DIR}/`)
  }
  else if (signal == 0 && downloads_backup) {
    consola.log(`-> Remove backup`)
    shell.rm('-rf', downloads_backup)
  }
});
