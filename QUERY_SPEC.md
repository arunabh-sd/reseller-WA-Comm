# Metabase Query Spec — WA Broadcaster Product Feed

The broadcaster reads from one primary Metabase question.
Set its ID in Railway env var: `METABASE_PRODUCT_QUESTION_ID`

## Required columns

| Column | Type | Source | Notes |
|--------|------|--------|-------|
| `customer_product_short_id` | string | products table | Product ID, e.g. `ysi98MUn` |
| `product_name` | string | products | Full display title |
| `sharable_desc` | string | products | 1–3 sentence description |
| `clean_product_type` | string | products | e.g. `womens_clothing__womens_ethnic_wear__kurta_set` |
| `mrp` | number | SKU | Original price |
| `reseller_selling_price` | number | SKU | Reseller price |
| `image_url` | string | products | First product image (CDN URL) |
| `product_url` | string | derived | Full qrate.shopdeck.com link |
| `sizes` | string | SKUs (aggregated) | Comma-separated, e.g. "S/36, M/38, L/40" |
| `l30d_orders` | number | orders | Seller orders last 30 days (bestseller filter: ≥10) |

## Optional columns (add to unlock more message features)

| Column | Type | Notes |
|--------|------|-------|
| `l7d_views` | number | Reseller product views last 7 days |
| `l7d_shares` | number | Reseller shares last 7 days |
| `has_video` | boolean | True if customer review video exists |
| `myntra_price` | number | Myntra price for same/similar product |
| `myntra_url` | string | Myntra product link |
| `website_price` | number | Brand website price |
| `website_url` | string | Brand website link |

## Product URL format
```
https://qrate.shopdeck.com/{title-slug}/catalogue/{product_id}/{sku_short_id}
```
Easiest to pre-compute this in the SQL query itself.

## Notes
- One row per product (not per SKU) — sizes should be aggregated as a string
- Only include active, in-stock products
- The broadcaster applies its own filters (≥10 L30D orders, 30-day no-repeat, AOV band)
  so the query can return the full eligible pool — no need to pre-filter by category
