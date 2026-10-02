// Counts DB calls per request (index.js puts { db: 0 } in reqStore for each request).
// Loaded before any model is compiled, because mongoose.plugin only applies to models created after it.
const { AsyncLocalStorage } = require("async_hooks");
const mongoose = require("mongoose");

const reqStore = new AsyncLocalStorage();
const count = function () {
  const store = reqStore.getStore();
  if (store) store.db += 1;
};
mongoose.plugin((schema) => {
  ["find", "findOne", "countDocuments", "findOneAndUpdate", "updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndDelete", "distinct"].forEach((op) =>
    schema.pre(op, count),
  );
  schema.pre("aggregate", count);
  schema.pre("save", count);
  schema.pre("insertMany", count);
});

module.exports = { reqStore };
