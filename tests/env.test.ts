import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config/env.js";

test("loadConfig：.env 留空的可选项归一为 undefined，不炸启动校验", () => {
  const config = loadConfig({
    GEYSER_ENDPOINT: "grpc.example.com:443",
    GEYSER_X_TOKEN: "",
    GEYSER_SECONDARY_ENDPOINT: "",
    TELEGRAM_BOT_TOKEN: "",
    WALLET_SECRET_KEY: "",
    SOLANA_RPC_HTTP: "https://api.mainnet-beta.solana.com",
    DRY_RUN: "true",
  });
  assert.equal(config.GEYSER_X_TOKEN, undefined);
  assert.equal(config.GEYSER_SECONDARY_ENDPOINT, undefined);
  assert.equal(config.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(config.WALLET_SECRET_KEY, undefined);
  assert.equal(config.DRY_RUN, true);
  // 回本线默认值：+100% 卖 60%
  assert.equal(config.EXIT_RECOVERY_TARGET_PCT, 100);
  assert.equal(config.EXIT_RECOVERY_SELL_PCT, 60);
});

test("loadConfig：缺必填项 fail-fast", () => {
  assert.throws(() => loadConfig({}), /环境变量配置不合法/);
});
