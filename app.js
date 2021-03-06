/**
 * (C) Copyright IBM Corp. 2019.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var os = require('os');
const express = require('express');
let i = 0;

const app = express();

const vcapServices = require('vcap_services');

const LanguageTranslatorV3 = require('ibm-watson/language-translator/v3');
const SpeechToTextV1 = require('ibm-watson/speech-to-text/v1.js');
const TextToSpeechV1 = require('ibm-watson/text-to-speech/v1.js');

const NaturalLanguageUnderstandingV1 = require('ibm-watson/natural-language-understanding/v1');
const { IamAuthenticator } = require('ibm-watson/auth');

const { IamTokenManager } = require('ibm-watson/auth');
const { Cp4dTokenManager } = require('ibm-watson/auth');



let sttUrl = process.env.SPEECH_TO_TEXT_URL;

// Ensure we have a SPEECH_TO_TEXT_AUTH_TYPE so we can get a token for the UI.
let sttAuthType = process.env.SPEECH_TO_TEXT_AUTH_TYPE;
if (!sttAuthType) {
  sttAuthType = 'iam';
} else {
  sttAuthType = sttAuthType.toLowerCase();
}
// Get a token manager for IAM or CP4D.
let tokenManager = false;
if (sttAuthType === 'cp4d') {
  tokenManager = new Cp4dTokenManager({
    username: process.env.SPEECH_TO_TEXT_USERNAME,
    password: process.env.SPEECH_TO_TEXT_PASSWORD,
    url: process.env.SPEECH_TO_TEXT_AUTH_URL,
    disableSslVerification: process.env.SPEECH_TO_TEXT_AUTH_DISABLE_SSL || false
  });
} else if (sttAuthType === 'iam') {
  let apikey = process.env.SPEECH_TO_TEXT_APIKEY;
  if (!(apikey && sttUrl)) {
    // If no runtime env override for both, then try VCAP_SERVICES.
    const vcapCredentials = vcapServices.getCredentials('speech_to_text');
    // Env override still takes precedence.
    apikey = apikey || vcapCredentials.apikey;
    sttUrl = sttUrl || vcapCredentials.url;
  }
  tokenManager = new IamTokenManager({ apikey });
} else if (sttAuthType === 'bearertoken') {
  console.log('SPEECH_TO_TEXT_AUTH_TYPE=bearertoken is for dev use only.');
} else {
  console.log('SPEECH_TO_TEXT_AUTH_TYPE =', sttAuthType);
  console.log('SPEECH_TO_TEXT_AUTH_TYPE is not recognized.');
}

// Init the APIs using environment-defined auth (default behavior).
const speechToText = new SpeechToTextV1({ version: '2019-12-16' });
const languageTranslator = new LanguageTranslatorV3({ version: '2019-12-16' });
const textToSpeech = new TextToSpeechV1({ version: '2019-12-16' });

nluApiKey = process.env.NATURAL_LANGUAGE_UNDERSTANDING_APIKEY;
nluUrl = process.env.NATURAL_LANGUAGE_UNDERSTANDING_URL;
const naturalLanguageUnderstanding = new NaturalLanguageUnderstandingV1({
  version: '2019-07-12',
  authenticator: new IamAuthenticator({
    apikey: nluApiKey,
  }),
  url: nluUrl,
});







// Get supported source language for Speech to Text
let speechModels = [];
speechToText
  .listModels()
  .then(response => {
    speechModels = response.result.models; // The whole list
    // Filter to only show one band.
    speechModels = response.result.models.filter(model => model.rate > 8000); // TODO: Make it a .env setting
    // Make description be `[lang] description` so the sort-by-lang makes sense.
    speechModels = speechModels.map(m => ({ ...m, description: `[${m.language}]  ${m.description}` }));
    speechModels.sort(function (a, b) {  // eslint-disable-line
      // Sort by 1 - language, 2 - description.
      return a.language.localeCompare(b.language) || a.description.localeCompare(b.description);
    });
  })
  .catch(err => {
    console.log('error: ', err);
  });

// Get supported language translation targets
const modelMap = {};
languageTranslator
  .listModels()
  .then(response => {
    for (const model of response.result.models) {  // eslint-disable-line
      const { source, target } = model;
      if (!(source in modelMap)) {
        modelMap[source] = new Set([target]);
      } else {
        modelMap[source].add(target);
      }
    }
    // Turn Sets into arrays.
    for (const k in modelMap) {  // eslint-disable-line
      modelMap[k] = Array.from(modelMap[k]);
    }
  })
  .catch(err => {
    console.log('error: ', err);
  });

// Get supported source language for Speech to Text
let voices = [];
textToSpeech
  .listVoices()
  .then(response => {
    // There are many redundant voices. For now the V3 ones are the best ones.
    voices = response.result.voices.filter(voice => voice.name.includes('V3')); // TODO: env param.
  })
  .catch(err => {
    console.log('error: ', err);
  });

// Bootstrap application settings
require('./config/express')(app);

const getFileExtension = acceptQuery => {
  const accept = acceptQuery || '';
  switch (accept) {
    case 'audio/ogg;codecs=opus':
    case 'audio/ogg;codecs=vorbis':
      return 'ogg';
    case 'audio/wav':
      return 'wav';
    case 'audio/mpeg':
      return 'mpeg';
    case 'audio/webm':
      return 'webm';
    case 'audio/flac':
      return 'flac';
    default:
      return 'mp3';
  }
};

app.get('/', (req, res) => {
  res.render('index');
});

// Get credentials using your credentials
app.get('/api/v1/credentials', async (req, res, next) => {
  if (tokenManager) {
    try {
      const accessToken = await tokenManager.getToken();
      res.json({
        accessToken,
        serviceUrl: sttUrl
      });
    } catch (err) {
      console.log('Error:', err);
      next(err);
    }
  } else if (process.env.SPEECH_TO_TEXT_BEARER_TOKEN) {
    res.json({
      accessToken: process.env.SPEECH_TO_TEXT_BEARER_TOKEN,
      serviceUrl: sttUrl
    });
  } else {
    console.log('Failed to get a tokenManager or a bearertoken.');
  }
});

/**
 * Language Translator
 */
// app.get('/api/v1/translate', async (req, res) => {
//   const inputText = req.query.text;

//   const ltParams = {
//     text: inputText,
//     source: req.query.source.substring(0, 2),
//     target: req.query.voice.substring(0, 2)
//   };

//   const doTranslate = ltParams.source !== ltParams.target;

//   try {
//     // Use language translator only when source language is not equal target language
//     if (doTranslate) {
//       const ltResult = await languageTranslator.translate(ltParams);
//       req.query.text = ltResult.result.translations[0].translation;
//     } else {
//       // Same language, skip LT, use input text.
//       req.query.text = inputText;
//     }

//     console.log('TRANSLATED:', inputText, ' --->', req.query.text);
//     res.json({ translated: req.query.text });
//   } catch (error) {
//     console.log(error);
//     res.send(error);
//   }
// });

/**
 * NLU 
 */
//NLU

app.get('/api/v1/translate', async (req, res) => {

let inputText = '';

if(i == 0)
{
  inputText = 'flood flood flood flood flood flood flood flood flood flood.'
}
else if (i == 1) 
{
  inputText = 'fire fire fire fire fire fire fire fire fire fire.'
}
else
{
  inputText = 'can you help with my refrigerator please. it is cold. thank you.'
}
i++;


  // const inputText = req.query.text;
  // const inputText = 'fire fire fire fire fire fire fire fire fire fire.'
  //const inputText = 'flood flood flood flood flood flood flood flood flood flood.'
  // const inputText = 'can you help with my refrigerator please. it is cold. thank you.'
  // const inputText = 'I created a fire by forgetting the food I had in the oven'
  console.log(inputText);

  const analyzeParams =
  {
    'text': inputText,
    'features':
    {
      'entities':
      {
        'emotion': true,
        'sentiment': true,
        'limit': 2,
      },
      'keywords':
      {
        'emotion': true,
        'sentiment': true,
        'limit': 2,
      },


      // 'emotion': 
      // {
      //   'targets': 
      //   [
      //     'fire',
      //   ]
      // },

      // 'relations':
      // {
      //   'model': '4723ec5f-7e27-40d4-9abf-dfd9454eee21'
      // },

      // 'sentiment': 
      // {
      //   'document': true
      // },

      'entities': {
        'model': '09d21d6f-e59a-4acb-af2f-cbc053e8eb0e'
      },
      // 'keywords': {
      //   'emotion': true,
      //   "sentiment": true
      // },
      // "emotion": {
      //   "sentiment": true
      // },
      'emotion':
      {
        'targets':
          [
            'flood','fire'
          ]
      },
      // "categories": {
      //   "sentiment": true
      // },
      "relations": {
        "model": '09d21d6f-e59a-4acb-af2f-cbc053e8eb0e'
      },
      // "sentiment": {}
    }
  };
  try {
    //const ltResult = await naturalLanguageUnderstanding.analyze(analyzeParams);

    const outputNLU = await naturalLanguageUnderstanding.analyze(analyzeParams);
    console.log('OutputNLU: ' + outputNLU);
    let obj = await JSON.stringify(outputNLU, null, 2);
    // req.query.text = await naturalLanguageUnderstanding.analyze(analyzeParams);
    // let obj = await JSON.stringify(req.query.text, null, 2);

    let abc = await JSON.parse(obj);
    console.log(abc);
    // req.query.text = abc.result.emotion.targets[0].emotion.fear;



    if (abc.result.relations.length == 0) {
      console.log(typeof(abc.result.emotion));
      if (abc.result.emotion == undefined) {
        req.query.text = 'Danger Detected: None'+ ',' + ' Danger Score: 0%';
        console.log('1');
      }
      else if (abc.result.emotion.targets[0].text == 'fire') 
      {
        let parseSad = await abc.result.emotion.targets[0].emotion.sadness;
        let parseJoy = await abc.result.emotion.targets[0].emotion.joy;
        let parseAnger = await abc.result.emotion.targets[0].emotion.anger; 
        let dangerScoreFire = await 0.46+ 1.2*parseSad + 1.2*parseAnger - (parseJoy)/2;
        if (parseSad > 0.10 && parseJoy < 0.80 && parseAnger > 0.05) 
        {
          req.query.text = 'Danger Detected: Fire' + ',' + ' Danger Score: ' + ((dangerScoreFire*100).toPrecision(2))+'%';
          console.log('2');
        }
        else 
        {
          req.query.text = 'Danger Detected: None' + ',' + ' Danger Score: 0%';
          console.log('3');
        }
      }
      else 
      {
        let parseSadF = await abc.result.emotion.targets[0].emotion.sadness;
        let parseJoyF = await abc.result.emotion.targets[0].emotion.joy;
        let parseAngerF = await abc.result.emotion.targets[0].emotion.anger;
        let dangerScoreFlood = await 0.2 + 1.2*parseSadF + 1.2*parseAngerF - (parseJoyF)/2;
        if (parseSadF > 0.05 && parseJoyF < 0.20 && parseAngerF > 0.20) 
        {
          req.query.text = 'Danger Detected: Flood' + ',' + ' Danger Score: ' + ((dangerScoreFlood*100).toPrecision(2))+'%';
          console.log('4');
        }
        else 
        {
          req.query.text = 'Danger Detected: None' + os.EOL + ' Danger Score: 0%';
          console.log('5');
        }
        console.log('ParseSadF: ' + parseSadF + ' ParseJoyF ' + parseJoyF + ' ParseAngerF ' + parseAngerF);
      }
    }
    else 
    {
      let parseScore = await abc.result.relations[0].score;
      let parseDanger = await abc.result.relations[0].arguments[1].entities[0].disambiguation.subtype[0];
      let combined = 'Danger Detected: ' + parseDanger + ',' + ' Danger Score: ' + (parseScore*100)+'%';
      req.query.text = combined;
    }

    // if (abc.result.relations[0] == null) 
    // {
    //   if (parseSadF > 0.05 && parseJoyF < 0.20 && parseAngerF > 0.50) 
    //   {
    //     req.query.text = 'Danger Detected: Flood';
    //   }
    //   else
    //   {
    //     req.query.text = 'Danger Detected: No Danger';
    //   }
    // }
    // else
    // {
    //   let parseScore = await abc.result.relations[0].score;
    //   let parseDanger = await abc.result.relations[0].arguments[1].entities[0].disambiguation.subtype[0];
    //   let combined = 'Danger Detected: ' + parseDanger + ' Danger Score: ' + parseScore;
    //   req.query.text = combined;
    // } 

    console.log(req.query.text);

    naturalLanguageUnderstanding.analyze(analyzeParams)
      .then(analysisResults => {
        console.log(JSON.stringify(analysisResults, null, 2));
      })

    console.log(req.query.text);

    await res.json({ translated: req.query.text });
  }
  catch (error) {
    console.log(error);
    res.send(error);
  }
});

/**
 * Pipe the synthesize method
 */
app.get('/api/v1/synthesize', async (req, res, next) => {
  try {
    // console.log('TEXT-TO-SPEECH:', req.query.text);
    const { result } = await textToSpeech.synthesize(req.query);
    const transcript = result;
    // transcript.on('response', response => {
    //   if (req.query.download) {
    //     response.headers['content-disposition'] = `attachment; filename=transcript.${getFileExtension(req.query.accept)}`;
    //   }
    // });
    // transcript.on('error', next);
    // transcript.pipe(res);
  } catch (error) {
    console.log(error);
    res.send(error);
  }
});

// Return the models, voices, and supported translations.
app.get('/api/v1/voices', async (req, res, next) => {
  try {
    res.json({
      modelMap,
      models: speechModels,
      voices
    });
  } catch (error) {
    next(error);
  }
});

// error-handler settings
require('./config/error-handler')(app);

module.exports = app;
