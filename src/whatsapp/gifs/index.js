const path = require('path');

// Original, locally bundled clips only. The model may choose an id from this
// list, never a URL, so it cannot fetch or send unsafe third-party media.
const GIFS = Object.freeze({
  access_unlocked: {
    id: 'access_unlocked',
    filename: 'access-unlocked.mp4',
    mimetype: 'video/mp4',
  },
  mission_complete: {
    id: 'mission_complete',
    filename: 'mission-complete.mp4',
    mimetype: 'video/mp4',
  },
  coffee_next: {
    id: 'coffee_next',
    filename: 'coffee-next.mp4',
    mimetype: 'video/mp4',
  },
});

const GIF_IDS = Object.freeze(Object.keys(GIFS));

function getGif(id) {
  const gif = GIFS[id];
  return gif ? { ...gif, path: path.join(__dirname, gif.filename) } : null;
}

module.exports = { GIFS, GIF_IDS, getGif };
