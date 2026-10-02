import test from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { normalizeWebsitePath, normalizeSource, applyWebsiteEvent, websiteSummary, registerWebsiteAnalytics } from '../website-analytics.mjs';

test('website path allowlist excludes private app and arbitrary paths', () => {
  assert.equal(normalizeWebsitePath('/software.html?x=1'), '/software');
  assert.equal(normalizeWebsitePath('/contact/'), '/contact');
  assert.equal(normalizeWebsitePath('/books/why-training-isnt-working'), '/books/why-training-isnt-working');
  assert.equal(normalizeWebsitePath('/signin'), '');
  assert.equal(normalizeWebsitePath('/api/db'), '');
  assert.equal(normalizeWebsitePath('/something-private'), '');
});
test('sources are referral hosts only and self-referrals do not identify visitors', () => {
  assert.equal(normalizeSource(''), 'Direct / unknown');
  assert.equal(normalizeSource('www.athlyrax.com'), 'Internal');
  assert.equal(normalizeSource('example.org'), 'example.org');
  assert.equal(normalizeSource('example.org/a?email=hi'), 'Other / unknown');
});
test('daily metrics count only allowed events, never retain visitor identity', () => {
  const data = { startedAt: '2026-10-02T00:00:00.000Z', days: {} };
  const date = '2026-10-02';
  assert.equal(applyWebsiteEvent(data, { event: 'page_view', path: '/', source: '', consent: true }, date), true);
  assert.equal(applyWebsiteEvent(data, { event: 'session_start', path: '/', source: 'example.org', consent: true }, date), true);
  assert.equal(applyWebsiteEvent(data, { event: 'enquiry_click', path: '/contact', consent: true }, date), true);
  assert.equal(applyWebsiteEvent(data, { event: 'enquiry_click', path: '/signin', consent: true }, date), false);
  assert.deepEqual(data.days[date], { pageViews: 1, estimatedSessions: 1, enquiryClicks: 1, pages: { '/': 1 }, sources: { 'example.org': 1 } });
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /ip|userAgent|userId|sessionId|cookie/);
});
test('owner summary dates, windows and totals are independently labelled', () => {
  const data = { startedAt: '2026-10-01T10:00:00.000Z', days: { '2026-10-01': { pageViews: 7, estimatedSessions: 3, enquiryClicks: 1, pages: { '/': 5, '/software': 2 }, sources: { 'Direct / unknown': 3 } }, '2026-09-01': { pageViews: 99, estimatedSessions: 99, enquiryClicks: 99 } } };
  const summary = websiteSummary(data, 7, new Date('2026-10-02T12:00:00Z'));
  assert.equal(summary.periodDays, 7);
  assert.deepEqual(summary.totals, { pageViews: 7, estimatedSessions: 3, enquiryClicks: 1 });
  assert.deepEqual(summary.topPages[0], { name: '/', count: 5 });
  assert.equal(summary.trend.length, 7);
  assert.equal(summary.trend.at(-1).date, '2026-10-02');
  assert.equal(websiteSummary(data, 999, new Date('2026-10-02T00:00:00Z')).periodDays, 30);
});

test('public statistical collection requires origin and valid purpose; owner reporting is authenticated', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-web-analytics-'));
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  registerWebsiteAnalytics(app, {
    storageRoot: tmp,
    requireStrictAuth: (req, res, next) => req.headers['x-test-auth'] === 'yes' ? next() : res.status(401).end(),
    requireSoftwareOwnerRole: (req, res, next) => req.headers['x-test-owner'] === 'yes' ? next() : res.status(403).end(),
    resolveClientKey: () => 'test-rate-bucket',
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const root = 'http://127.0.0.1:' + server.address().port;
    const payload = { event: 'page_view', path: '/software', consent: true, source: '' };
    const request = (origin, body = payload) => fetch(root + '/website-analytics/collect', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    assert.equal((await request('https://invalid.example')).status, 403);
    assert.equal((await request('https://athlyrax.com', { ...payload, consent: false })).status, 400);
    assert.equal((await request('https://athlyrax.com', { event: 'page_view', path: '/software', purpose: 'statistics', source: '' })).status, 204);
    assert.equal((await request('https://athlyrax.com', { event: 'page_view', path: '/software', purpose: 'marketing' })).status, 400);
    assert.equal((await request('https://athlyrax.com', { ...payload, path: '/api/db' })).status, 400);
    assert.equal((await request('https://athlyrax.com')).status, 204);
    assert.equal((await fetch(root + '/website-analytics/owner-summary')).status, 401);
    assert.equal((await fetch(root + '/website-analytics/owner-summary', { headers: { 'x-test-auth': 'yes' } })).status, 403);
    const ok = await fetch(root + '/website-analytics/owner-summary?days=7', { headers: { 'x-test-auth': 'yes', 'x-test-owner': 'yes' } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control') || '', /no-store/);
    const report = await ok.json();
    assert.equal(report.totals.pageViews, 2);
    assert.deepEqual(report.topPages[0], { name: '/software', count: 2 });
    const raw = fs.readFileSync(path.join(tmp, 'website-analytics-aggregate.json'), 'utf8');
    assert.doesNotMatch(raw, /test-rate-bucket|x-test-auth|visitorId/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
