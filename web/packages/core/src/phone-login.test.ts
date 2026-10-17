// SPEC4_1_4a: a login screen offers a phone option only when credentialMethods
// has "otp" AND phoneChannels is present and non-empty. Absent is not [].
import { test } from "node:test";
import assert from "node:assert/strict";
import { offersPhoneLogin } from "./phone-login.js";
import type { ProvidersResponse } from "./types.js";

const base: ProvidersResponse = { providers: [] };

test("SPEC4_1_4a offersPhoneLogin: otp + a non-empty list offers a phone option", () => {
  assert.equal(offersPhoneLogin({ ...base, credentialMethods: ["otp"], phoneChannels: ["whatsapp", "sms"] }), true);
  assert.equal(offersPhoneLogin({ ...base, credentialMethods: ["password", "otp"], phoneChannels: ["sms"] }), true);
});

test("SPEC4_1_4a offersPhoneLogin: [] offers nothing", () => {
  assert.equal(offersPhoneLogin({ ...base, credentialMethods: ["otp"], phoneChannels: [] }), false);
});

test("SPEC4_1_4a offersPhoneLogin: absent (older issuer) offers nothing", () => {
  assert.equal(offersPhoneLogin({ ...base, credentialMethods: ["otp"] }), false);
});

test("SPEC4_1_4a offersPhoneLogin: phone channels without otp offer nothing", () => {
  assert.equal(offersPhoneLogin({ ...base, credentialMethods: ["password"], phoneChannels: ["sms"] }), false);
  assert.equal(offersPhoneLogin({ ...base, phoneChannels: ["sms"] }), false);
});
