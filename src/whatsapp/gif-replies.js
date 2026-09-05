const fs = require('fs/promises');
const { MessageMedia } = require('whatsapp-web.js');
const { getGif } = require('./gifs');

async function sendGifReply(msg, gifId) {
  const gif = getGif(gifId);
  if (!gif) throw new Error('unknown approved GIF');

  const bytes = await fs.readFile(gif.path);
  const media = new MessageMedia(gif.mimetype, bytes.toString('base64'), gif.filename);
  await msg.reply(media, undefined, { sendVideoAsGif: true });
}

module.exports = { sendGifReply };
