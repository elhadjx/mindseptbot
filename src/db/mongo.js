const mongoose = require('mongoose');
const { config } = require('../config');

async function connectMongo() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  console.log('[mongo] connected');
  return mongoose;
}

module.exports = { mongoose, connectMongo };
