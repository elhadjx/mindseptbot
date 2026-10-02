const assert = require('assert');
const fs = require('fs');
const {
  DoorAI,
  isDoorIntentCandidate,
  isWorkplaceSafeText,
} = require('../src/ai/door-ai');
const { GIF_IDS, getGif } = require('../src/whatsapp/gifs');
const { sendGifReply } = require('../src/whatsapp/gif-replies');
const { createAIClient } = require('../src/ai/provider');

function fakeClient(outputs, moderation = { flagged: false, categories: {} }) {
  const queue = [...outputs];
  const moderationQueue = Array.isArray(moderation) ? [...moderation] : null;
  return {
    enabled: true,
    schemas: [],
    moderated: [],
    async structured(request) {
      this.schemas.push(request.schema);
      const output = queue.shift();
      if (output instanceof Error) throw output;
      return output;
    },
    async moderate(text) {
      this.moderated.push(text);
      const result = moderationQueue ? moderationQueue.shift() : moderation;
      if (result instanceof Error) throw result;
      return result;
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

  const unsafeClient = fakeClient(Array(3).fill({ mode: 'text', reply: 'Une blague stupide.', gifId: '' }));
  const unsafeAI = new DoorAI({ client: unsafeClient });
  assert.strictEqual(
    await unsafeAI.rewriteReply({ outcome: 'granted', canonicalReply: 'Ouvert', gifChancePct: 0 }),
    null
  );
  assert.strictEqual(unsafeClient.moderated.length, 0);
  assert.strictEqual(unsafeClient.schemas.length, 3);

  const moderationDown = fakeClient(
    Array(3).fill({ mode: 'text', reply: 'La porte est ouverte.', gifId: '' }),
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
  assert.strictEqual(moderationDown.moderated.length, 3);

  const safeReply = { mode: 'text', reply: 'Bienvenue, la porte est ouverte 🚪', gifId: '' };
  const replyInput = { outcome: 'granted', canonicalReply: 'Ouvert 🚪', gifChancePct: 0 };
  for (const failure of [new Error('request timed out'), { mode: 'broken' }]) {
    for (const retries of [1, 2]) {
      const client = fakeClient([...Array(retries).fill(failure), safeReply]);
      assert.deepStrictEqual(await new DoorAI({ client }).rewriteReply(replyInput), {
        mode: 'text', reply: safeReply.reply,
      });
      assert.strictEqual(client.schemas.length, retries + 1);
      assert.strictEqual(client.moderated.length, 1);
    }
  }

  const exhausted = fakeClient(Array(4).fill(new Error('request timed out')));
  assert.strictEqual(await new DoorAI({ client: exhausted }).rewriteReply(replyInput), null);
  assert.strictEqual(exhausted.schemas.length, 3, 'stop after exactly two retries');

  const repeated = fakeClient([
    { mode: 'text', reply: replyInput.canonicalReply, gifId: '' },
    safeReply, safeReply,
    { mode: 'text', reply: 'Accès ouvert, place au café ☕', gifId: '' },
  ]);
  const variedAI = new DoorAI({ client: repeated });
  assert.strictEqual((await variedAI.rewriteReply(replyInput)).reply, safeReply.reply);
  assert.strictEqual((await variedAI.rewriteReply(replyInput)).reply, 'Accès ouvert, place au café ☕');
  assert.strictEqual(repeated.schemas.length, 4);
  assert.strictEqual(repeated.moderated.length, 2, 'copies must not reach moderation');

  for (const failure of [new Error('moderation unavailable'), { flagged: true }]) {
    const client = fakeClient([safeReply, safeReply], [failure, { flagged: false }]);
    assert.strictEqual((await new DoorAI({ client }).rewriteReply(replyInput)).reply, safeReply.reply);
    assert.strictEqual(client.moderated.length, 2);
  }

  for (const provider of ['openai', 'gemini']) {
    let configuredTimeout;
    const ai = new DoorAI({ clientFactory: (selected, options) => {
      assert.strictEqual(selected, provider);
      const client = createAIClient(selected, 'fixture-key', options);
      configuredTimeout = client.timeoutMs;
      client.structured = async () => safeReply;
      client.moderate = async () => ({ flagged: false });
      return client;
    } });
    assert.strictEqual((await ai.rewriteReply({ ...replyInput, provider })).reply, safeReply.reply);
    assert.strictEqual(configuredTimeout, 4000);
  }

  let missingKeyAttempts = 0;
  const missingKey = new DoorAI({ clientFactory: () => { missingKeyAttempts++; return null; } });
  assert.strictEqual(await missingKey.rewriteReply(replyInput), null);
  assert.strictEqual(missingKeyAttempts, 1);

  const failedIntent = fakeClient([new Error('request timed out')]);
  assert.strictEqual(await new DoorAI({ client: failedIntent }).classifyDoorIntent('Open the door'), false);
  assert.strictEqual(failedIntent.schemas.length, 1, 'intent classification is never retried');

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
