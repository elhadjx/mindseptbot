const assert = require('assert');
const fs = require('fs');
const {
  DoorAI,
  isDoorIntentCandidate,
  isWorkplaceSafeText,
} = require('../src/ai/door-ai');
const { GIF_IDS, getGif } = require('../src/whatsapp/gifs');
const { sendGifReply } = require('../src/whatsapp/gif-replies');

function fakeClient(outputs, moderation = { flagged: false, categories: {} }) {
  const queue = [...outputs];
  return {
    enabled: true,
    schemas: [],
    moderated: [],
    async structured(request) {
      this.schemas.push(request.schema);
      return queue.shift();
    },
    async moderate(text) {
      this.moderated.push(text);
      if (moderation instanceof Error) throw moderation;
      return moderation;
    },
  };
}

async function main() {
  for (const request of [
    'Tu peux m’ouvrir ?',
    'Je suis devant, ouvrez-moi',
    'Please open the front door',
    'Let me in please',
    '7ell li el bab',
    'افتح لي الباب',
  ]) {
    assert.strictEqual(isDoorIntentCandidate(request), true, request);
  }
  for (const chatter of [
    'hello everyone',
    "n'ouvre pas la porte",
    'the door was opened yesterday',
    'la porte est ouverte',
    '> ouvre la porte',
  ]) {
    assert.strictEqual(isDoorIntentCandidate(chatter), false, chatter);
  }

  assert.strictEqual(isWorkplaceSafeText('Karim, mission porte accomplie ☕'), true);
  assert.strictEqual(isWorkplaceSafeText('Karim, mission porte accomplie ☕', 'Karim'), true);
  assert.strictEqual(isWorkplaceSafeText('La porte se moque de Karim.', 'Karim'), false);
  assert.strictEqual(isWorkplaceSafeText('Quelle blague stupide.'), false);
  assert.strictEqual(isWorkplaceSafeText('Regarde https://example.com'), false);

  const classifierClient = fakeClient([
    {
      action: 'open_front_door',
      explicitRequest: true,
      currentRequest: true,
      negated: false,
      ambiguous: false,
    },
    {
      action: 'none',
      explicitRequest: false,
      currentRequest: false,
      negated: false,
      ambiguous: true,
    },
  ]);
  const classifier = new DoorAI({ client: classifierClient });
  assert.strictEqual(await classifier.classifyDoorIntent('Tu peux m’ouvrir ?'), true);
  assert.strictEqual(await classifier.classifyDoorIntent('Please open the door maybe later'), false);
  assert.strictEqual(classifierClient.schemas[0].additionalProperties, false);

  const textClient = fakeClient([{ mode: 'text', reply: 'Nadia, la porte a obéi. Mission accomplie 🚪', gifId: '' }]);
  const textAI = new DoorAI({ client: textClient, random: () => 0.99 });
  const rewritten = await textAI.rewriteReply({
    outcome: 'granted',
    canonicalReply: 'Ouvert 🚪',
    name: 'Nadia Example',
    message: '/open',
    allowGifs: true,
    gifChancePct: 15,
  });
  assert.deepStrictEqual(rewritten, {
    mode: 'text',
    reply: 'Nadia, la porte a obéi. Mission accomplie 🚪',
  });
  assert.strictEqual(textClient.moderated.length, 1);

  const gifClient = fakeClient([{ mode: 'gif', reply: '', gifId: 'coffee_next' }]);
  const gifAI = new DoorAI({ client: gifClient, random: () => 0 });
  assert.deepStrictEqual(
    await gifAI.rewriteReply({
      outcome: 'granted',
      canonicalReply: 'Ouvert 🚪',
      name: 'Nadia',
      message: '/open',
      allowGifs: true,
      gifChancePct: 15,
    }),
    { mode: 'gif', gifId: 'coffee_next' }
  );

  // Even a zero random value cannot turn an error into a GIF.
  const errorClient = fakeClient([{ mode: 'text', reply: "Ça n'a pas marché, admin prévenu.", gifId: '' }]);
  const errorAI = new DoorAI({ client: errorClient, random: () => 0 });
  assert.strictEqual(
    (
      await errorAI.rewriteReply({
        outcome: 'error',
        canonicalReply: "Ça n'a pas marché.",
        allowGifs: true,
        gifChancePct: 30,
      })
    ).mode,
    'text'
  );
  assert.deepStrictEqual(errorClient.schemas[0].properties.mode.enum, ['text']);

  const unsafeClient = fakeClient([{ mode: 'text', reply: 'Une blague stupide.', gifId: '' }]);
  const unsafeAI = new DoorAI({ client: unsafeClient });
  assert.strictEqual(
    await unsafeAI.rewriteReply({ outcome: 'granted', canonicalReply: 'Ouvert', gifChancePct: 0 }),
    null
  );
  assert.strictEqual(unsafeClient.moderated.length, 0);

  const moderationDown = fakeClient(
    [{ mode: 'text', reply: 'La porte est ouverte.', gifId: '' }],
    new Error('moderation unavailable')
  );
  assert.strictEqual(
    await new DoorAI({ client: moderationDown }).rewriteReply({
      outcome: 'granted',
      canonicalReply: 'Ouvert',
      gifChancePct: 0,
    }),
    null
  );

  assert.strictEqual(GIF_IDS.length, 3);
  for (const id of GIF_IDS) {
    const bytes = fs.readFileSync(getGif(id).path);
    assert.ok(bytes.length > 1000, `${id} should contain media`);
    assert.strictEqual(bytes.subarray(4, 8).toString(), 'ftyp', `${id} should be an MP4`);
  }

  const sent = [];
  await sendGifReply(
    {
      reply: async (...args) => sent.push(args),
    },
    'access_unlocked'
  );
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][0].mimetype, 'video/mp4');
  assert.strictEqual(sent[0][2].sendVideoAsGif, true);

  console.log('door AI tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
