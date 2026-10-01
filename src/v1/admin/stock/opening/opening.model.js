const mongoose = require("mongoose");
const { docSchema } = require("../stock.doc");

// Opening stock at go-live (OB-2610-0001): qty + cost (+ batch / expiry) already on the shelves
module.exports = mongoose.model("StockOpening", docSchema());
