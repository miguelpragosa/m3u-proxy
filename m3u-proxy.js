#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const get = require('simple-get');
const byline = require('byline');
const flow = require('xml-flow');

const debug = require('debug')('m3u-proxy');

// Definitions for command line araguments
const definitions = [
  { name: 'config', alias: 'c', type: String, defaultValue: './config.json' }
];
const cmdLineArgs = require('command-line-args');
// const { resolve } = require('path');
// Set passed arguments
const args = cmdLineArgs(definitions);

const config = require(args.config);


const getFile = (url, filename) => {
  debug(` ┌getFile: ${filename}`);
  return new Promise(resolve => {
    // Prepare destination
    const dirname = path.dirname(filename);
    if (!fs.existsSync(dirname)) fs.mkdirSync(dirname, { recursive: true });
	
    // and download
    get({ url: url, rejectUnauthorized: false }, (error, response) => {
	  if (response) {
	    debug(` └get: error=${error}; response.statusCode=${response.statusCode}`);
	  } else {
	    debug(` └get: error=${error}; response=${response}`);
	  }
	  
      if (error) {
        throw error;
      }
	  
	  if (response && response.statusCode != 200) {
		throw new Error(`Failed to load resource: ${url}`);
	  }
	  
      // pipe received data
      const tmpFilename = filename + '.tmp';
      const tmpFile = fs.createWriteStream(tmpFilename);
      response.pipe(tmpFile);
      // and close
      response.on('end', () => {
        if (fs.existsSync(filename)) fs.unlinkSync(filename);
        fs.renameSync(tmpFilename, filename);
        debug(` └getFile: ${filename}`);
        resolve();
      });
    });
    // resolve();
  });
};

const M3UFilePrefix = /^#EXTM3U/;
const M3UPrefix = /^#EXTINF/;
const M3UFields = /^#EXTINF:-?\d+,?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?.*,(.*)/;
const StreamPrefix = /^http/;

const processM3U = (source, model) => {
  debug(` ┌M3U-Process: ${source.name}${model.name}`);
  return new Promise(resolve => {
    // Preparation
    if (model.filters) {
      for (let i = 0; i < model.filters.length; i++) model.filters[i].regex = new RegExp(model.filters[i].regex, 'i');
    }
    if (model.transformations) {
      for (let i = 0; i < model.transformations.length; i++) model.transformations[i].regex = new RegExp(model.transformations[i].regex, 'i');
    }

    // Loop
    const stream = byline.createStream(fs.createReadStream(`${config.importFolder}/${source.name}.m3u`, { encoding: 'utf8' }));
	
	const result = {
      filePrefix: "",
	  streams: [],
    };
	
    let fields = {};
    stream.on('data', (line) => {	  
	  // First line
      if (line.match(M3UFilePrefix)) {
		result.filePrefix = line + '\n';

	  // EXTINF lines
      } else if (line.match(M3UPrefix)) {
		// Make sure no matadata is stored as we're now starting to process a new channel
		delete fields['metadata'];
		
        // We get fields
        const matches = line.match(M3UFields);
        try {
          for (let i = 1; i < 8; i += 2) {
            if (matches[i]) fields[matches[i]] = matches[i + 1];
          }
          if (!fields['tvg-name']) fields['tvg-name'] = matches[11].trim();
          if (!fields['group-title']) fields['group-title'] = fields['tvg-name'].match(/\w*/); // Compact M3U files = no group-title
        } catch (err) {
          // Do nothing
        }
		
	  // Stream URL
      } else if (line.match(StreamPrefix)) {
        fields['stream'] = line;
        // Now let's check filters
        let valid;
        if (!model.filters) {
          valid = true;
        } else {
          valid = false;
          for (let i = 0; i < model.filters.length; i++) {
            if (model.filters[i].regex.test(fields[model.filters[i].field])) {
              valid = true;
              break;
            }
          }
        }

        // Do we need to apply transformations?
        if (valid && model.transformations) {
          for (let i = 0; i < model.transformations.length; i++) {
            fields[model.transformations[i].field] = fields[model.transformations[i].field].replace(model.transformations[i].regex, model.transformations[i].substitution);
          }
        }
        
        if (valid) result.streams.push(fields);
        fields = {};

      // Remaining lines (metadata)
      } else {
		if (!fields['metadata']) fields['metadata'] = ""
        fields['metadata'] += line + '\n';
      }
    });
    stream.on('end', () => {
      debug(` └M3U-Process: ${source.name}${model.name}`);
      resolve(result);
    });
  });
};

const exportM3U = (source, model, result) => {
  debug(` ┌M3U-Write: ${source.name}${model.name}`);
  return new Promise(resolve => {
    // Prepare destination
    if (!fs.existsSync(`${config.exportFolder}`)) fs.mkdirSync(`${config.exportFolder}`, { recursive: true });
    const file = fs.createWriteStream(`${config.exportFolder}/${source.name}${model.name}.m3u`);
    // And export
    file.write(result.filePrefix);
	
    result.streams.forEach(stream => {
      file.write(`#EXTINF:-1`);
      if (stream['tvg-id']) file.write(` tvg-id="${stream['tvg-id']}"`);
      if (stream['tvg-name']) file.write(` tvg-name="${stream['tvg-name']}"`);
      if (stream['tvg-logo']) file.write(` tvg-logo="${stream['tvg-logo']}"`);
      file.write(` group-title="${stream['group-title']}",${stream['tvg-name']}\n`);
	  if (stream['metadata']) file.write(`${stream['metadata']}`);
      file.write(`${stream['stream']}\n`);
    });
    file.end();
    debug(` └M3U-Write: ${source.name}${model.name}`);
    resolve();
  });
};

const diffHours = (dtStr) => {
  const pattern = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}) ([+\-0-9]{3})(\d{2})/;
  const dt = new Date(dtStr.replace(pattern, '$1-$2-$3 $4:$5:$6 $7:$8'));

  return (dt - new Date())/1000/60/60;
};

const processEPG = (source, streams) => {
  debug(` ┌EPG-Process: ${source.name}`);
  return new Promise(resolve => {
    // Always M3U before EPG, so no need to check export folder
    const xmlStream = flow(fs.createReadStream(`${config.importFolder}/${source.name}.xml`));
    const epg = fs.createWriteStream(`${config.exportFolder}/${source.name}.xml`);
    //
    epg.write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>\n');
    xmlStream.on('tag:channel', (node) => {
      if (typeof node.$attrs !== 'undefined' && node.$attrs.id !== '' && streams.indexOf(node.$attrs.id) >= 0) {
        epg.write(flow.toXml(node));
        epg.write('\n');
      }
    });
    xmlStream.on('tag:programme', (node) => {
      if (streams.indexOf(node.$attrs.channel) >= 0) {
        if (diffHours(node.$attrs.start) < 48 && diffHours(node.$attrs.stop) > -1) {// Starts in less than 48 hours and Finishes less than 1 hour ago
          epg.write(flow.toXml(node));
          epg.write('\n');
        }
      }
    });
    xmlStream.on('end', () => {
      epg.write('</tv>');
      debug(` └EPG-Process: ${source.name}`);
      resolve();
    });
  });
};

const processSource = async (source) => {
  debug(`┌Source: ${source.name}`);

  let streams;

  try {
    await getFile(source.m3u, `${config.importFolder}/${source.name}.m3u`);
    const models = [];
    for (const model of source.models) {
      models.push(processM3U(source, model)
        .then(async (result) => {
          await exportM3U(source, model, result);
        }));
    }
    await Promise.all(models);
  } catch (err) {
    console.log(err);
  }

  if (source.epg) {
    try {
      await getFile(source.epg, `${config.importFolder}/${source.name}.xml`);
      result = await processM3U(source, source.models[0]);
      await processEPG(source, result.streams.map(x => x['tvg-id']));
    } catch (err) {
      console.log(err);
    }
  }

  debug(`└Source: ${source.name}`);
};

(async () => {
  const sources = [];
  for (const source of config.sources) {
    sources.push(processSource(source));
  }
  Promise.all(sources);
})();
