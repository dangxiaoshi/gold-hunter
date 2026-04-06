const { DEFAULT_PORT } = require('./src/constants');
const { createApp } = require('./src/app');
const { chunkDoc, syncKnowledgeBase } = require('./src/services/kb-service');

const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const app = createApp({ port: PORT });

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🏹 金币猎人 运行中 → http://localhost:${PORT}\n`);
  });
}

module.exports = {
  app,
  chunkDoc,
  syncKnowledgeBase,
};
