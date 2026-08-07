'use strict';
// status.test.js — the status reporter's self-test (worker + author modes, batch
// grouping, counts) runs as part of the suite.

const { test } = require('node:test');
const assert = require('node:assert');
const { selfTest } = require('../src/status.js');

test('status --self-test renders both modes correctly', () => {
  assert.equal(selfTest(), true);
});
