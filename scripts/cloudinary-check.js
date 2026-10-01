// Cloudinary connection check — run from the project folder:
//   node scripts/cloudinary-check.js
// Prints: config (secret hidden), proxy vars, DNS, SDK ping, and a raw signed upload of a
// 1x1 PNG with the real HTTP status + response body (the SDK hides the body on a 403).
require("dotenv").config();
const dns = require("dns").promises;
const https = require("https");
const crypto = require("crypto");
const { cloudinary, ping, deleteFile } = require("../src/util/cloudinary");

const env = process.env;
const mask = (v = "") => (v.length > 4 ? "*".repeat(v.length - 4) + v.slice(-4) : v ? "****" : "(empty)");

async function step(title, fn) {
  console.log(`\n=== ${title}`);
  try {
    await fn();
  } catch (err) {
    console.log("ERROR:", err?.message || err, err?.code ? `(${err.code})` : "");
  }
}

(async () => {
  await step("1. Config from .env", async () => {
    console.log({
      CLOUDINARY_CLOUD_NAME: env.CLOUDINARY_CLOUD_NAME || "(empty)",
      CLOUDINARY_API_KEY: mask(env.CLOUDINARY_API_KEY),
      CLOUDINARY_API_SECRET: env.CLOUDINARY_API_SECRET ? `set (${env.CLOUDINARY_API_SECRET.length} chars)` : "(empty)",
      CLOUDINARY_FOLDER: env.CLOUDINARY_FOLDER || "(empty → le_blend)",
    });
    console.log("Proxy vars:", {
      HTTPS_PROXY: env.HTTPS_PROXY || env.https_proxy || null,
      HTTP_PROXY: env.HTTP_PROXY || env.http_proxy || null,
      NO_PROXY: env.NO_PROXY || env.no_proxy || null,
    });
  });

  await step("2. DNS api.cloudinary.com", async () => {
    console.log(await dns.lookup("api.cloudinary.com", { all: true }));
  });

  await step("3. SDK ping (Admin API: checks cloud name + key + secret)", async () => {
    try {
      console.log("OK", await ping());
    } catch (err) {
      console.log("PING FAILED:", err?.error?.message || err?.message || err, "| http_code:", err?.error?.http_code ?? err?.http_code);
    }
  });

  await step("4. Raw signed upload of a 1x1 PNG (real status + body)", async () => {
    const png = Buffer.from(
      "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8FFFF3F0005FE02FEA7D6A5A50000000049454E44AE426082",
      "hex",
    );
    const params = { folder: `${env.CLOUDINARY_FOLDER || "le_blend"}/others`, timestamp: Math.round(Date.now() / 1000) };
    const signature = cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET);
    const fields = { ...params, api_key: env.CLOUDINARY_API_KEY, signature };

    const boundary = "----lbcheck" + crypto.randomBytes(8).toString("hex");
    const parts = Object.entries(fields).map(
      ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    );
    const body = Buffer.concat([
      Buffer.from(parts.join("")),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="check.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.cloudinary.com",
          path: `/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
          timeout: 30000,
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout after 30s")));
      req.on("error", reject);
      req.end(body);
    });

    console.log("HTTP status:", result.status);
    console.log("Server:", result.headers.server, "| x-cld-error:", result.headers["x-cld-error"] || "-");
    console.log("Body:", result.body.slice(0, 800));

    if (result.status === 200) {
      const json = JSON.parse(result.body);
      await deleteFile(json.public_id).catch(() => {});
      console.log("✅ Upload works — test image deleted again.");
    }
  });

  console.log("\nDone.");
})();
