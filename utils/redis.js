const redis = require("redis");

const client = redis.createClient();

client.on("error", (err) => console.log("Redis Client Error", err));
client.connect();
exports.client = client; 
exports.createCache = async (key, value) => {
  await client.set(key, JSON.stringify(value), { EX: 5000 });
  console.log(`✅ Cached ${key}`);
  return;
};

exports.getCache = async (key) => {
  return await client.get(key);
};

// ✅ Set cache
exports.setCache = async (key, data, ttl = 3600) => {
  try {
    await client.setEx(key, ttl, JSON.stringify(data));
  } catch (error) {
    console.error("Error setting cache:", error);
  }
};