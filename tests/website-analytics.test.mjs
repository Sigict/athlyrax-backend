import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebsitePath, normalizeSource, applyWebsiteEvent, websiteSummary } from '../website-analytics.mjs';

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
