import {createRequestListener} from '../server.mjs';

export default createRequestListener({
  apiKey: process.env.NDAMAPS_API_KEY?.trim() || '',
  env: process.env,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg'
});
