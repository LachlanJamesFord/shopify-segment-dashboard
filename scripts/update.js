#!/usr/bin/env node
/*
 * update.js
 *
 * This script fetches last‑90‑day performance data for a Shopify segment and
 * writes the results into `public/data/segment.json`. It should be run
 * nightly by the accompanying GitHub Actions workflow.
 *
 * You must set the following environment variables (for GitHub Actions,
 * configure them as repository or organization secrets):
 *
 *   SHOPIFY_STORE       – your myshopify domain (e.g. `example.myshopify.com`)
 *   SHOPIFY_ADMIN_TOKEN – an Admin API access token for a private app with
 *                         read_orders scope
 *   GA4_PROPERTY_ID     – the numeric property ID for your Google Analytics 4 property
 *   GA4_CLIENT_EMAIL    – the client email for a Google service account
 *   GA4_PRIVATE_KEY     – the service account private key (escaped newlines okay)
 *
 * Optionally you can set:
 *   SEGMENT_SHOPIFY_QUERY – a query string for filtering orders in Shopify
 *                           (e.g. `tag:Wholesale`) or leave blank for all
 *   SEGMENT_GA_FILTER     – a JSON expression for GA4 dimension filtering
 *                           (see GA4 Data API docs). Leave blank for none.
 */

const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

// Helper to parse Shopify link header for pagination
function getNextPage(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',').map(p => p.trim());
  for (const part of parts) {
    const [urlPart, relPart] = part.split(';').map(s => s.trim());
    if (relPart === 'rel="next"') {
      const match = urlPart.match(/page_info=([^&>]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    }
  }
  return null;
}

async function fetchShopify() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN environment variables');
  }
  const queryString = process.env.SEGMENT_SHOPIFY_QUERY || '';
  // Compute ISO date range for the last 90 days
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 89);
  const processed_at_min = start.toISOString();
  const processed_at_max = end.toISOString();
  let url = `https://${store}/admin/api/2024-07/orders.json?status=any&limit=250&fields=total_price,created_at`;
  url += `&processed_at_min=${encodeURIComponent(processed_at_min)}`;
  url += `&processed_at_max=${encodeURIComponent(processed_at_max)}`;
  if (queryString) url += `&query=${encodeURIComponent(queryString)}`;
  let pageInfo = null;
  let orders = 0;
  let sales = 0;
  do {
    const fetchUrl = pageInfo ? `${url}&page_info=${encodeURIComponent(pageInfo)}` : url;
    const res = await fetch(fetchUrl, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    for (const order of data.orders) {
      orders++;
      sales += parseFloat(order.total_price || 0);
    }
    pageInfo = getNextPage(res.headers.get('link'));
  } while (pageInfo);
  return { orders, sales };
}

async function fetchGA4() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const clientEmail = process.env.GA4_CLIENT_EMAIL;
  const privateKey = process.env.GA4_PRIVATE_KEY && process.env.GA4_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (!propertyId || !clientEmail || !privateKey) {
    throw new Error('Missing GA4 service account credentials.');
  }
  const analyticsDataClient = new BetaAnalyticsDataClient({
    credentials: { client_email: clientEmail, private_key: privateKey }
  });
  // Prepare GA4 request
  const request = {
    property: `properties/${propertyId}`,
    dateRanges: [ { startDate: '90daysAgo', endDate: 'today' } ],
    metrics: [ { name: 'sessions' }, { name: 'sessionConversionRate' } ],
  };
  // Apply optional dimension filter if provided
  const dimFilter = process.env.SEGMENT_GA_FILTER;
  if (dimFilter) {
    try {
      request.dimensionFilter = JSON.parse(dimFilter);
    } catch (err) {
      console.warn('Invalid SEGMENT_GA_FILTER JSON, ignoring');
    }
  }
  const [response] = await analyticsDataClient.runReport(request);
  const row = response.rows && response.rows[0];
  const sessions = row ? parseFloat(row.metricValues[0].value) : 0;
  const conversionRate = row ? parseFloat(row.metricValues[1].value) : 0;
  return { sessions, conversionRate };
}

async function main() {
  const [shopify, ga] = await Promise.all([fetchShopify(), fetchGA4()]);
  // Compose output; you could compute deltas here by comparing to previous period
  const output = {
    sessions: Math.round(ga.sessions),
    orders: shopify.orders,
    sales: parseFloat(shopify.sales.toFixed(2)),
    conversionRate: parseFloat((ga.conversionRate * 100).toFixed(2)),
    // leaving delta fields null by default; compute if desired
    sessionsDelta: null,
    ordersDelta: null,
    salesDelta: null,
    conversionRateDelta: null,
    labels: null,
    series: null
  };
  const dest = path.join(__dirname, '../public/data/segment.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(output, null, 2));
  console.log('Updated', dest);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
