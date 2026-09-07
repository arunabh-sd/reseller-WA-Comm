# Metabase Query Spec — WA Broadcaster Product Feed

The broadcaster reads from two Metabase questions.
Set the primary card ID in Railway env var: `METABASE_PRODUCT_QUESTION_ID` (default: 14878)

## Card 14878 — Primary Product Feed (per SKU)

All ranking signals and product display data in one query.

| Column | Type | Notes |
|--------|------|-------|
| `seller_id` | string | Seller identifier |
| `seller_name` | string | Seller display name |
| `customer_product_short_id` | string | Product ID, e.g. `ysi98MUn` |
| `customer_sku_short_id` | string | SKU ID (used to build qrate URL) |
| `product_name` | string | Full display title |
| `img_link` | string | First product image (CDN URL) |
| `website_product_link` | string | Brand website product URL |
| `website_price` | number | Brand website price |
| `transfer_price` | number | Transfer/wholesale price |
| `reseller_selling_price_prepaid` | number | Reseller price (prepaid) |
| `cod_charge` | number | COD surcharge if any |
| `mp_price` | number | Marketplace (e.g. Myntra) price |
| `mp_name` | string | Marketplace name, e.g. "myntra" |
| `mp_link` | string | Marketplace product URL |
| `cheapest_non_meesho_price` | number | Cheapest non-Meesho marketplace price |
| `marketplace_count` | number | # marketplaces listing this product |
| `cheapest` | boolean | True if ShopDeck reseller price is cheapest |
| `exclusive` | boolean | True if not on any marketplace |
| `orders_last_30d` | number | Seller orders in last 30 days (bestseller filter: ≥10) |
| `ppo_last_7d` | number | Reseller product page opens in last 7 days |
| `shares_last_7d` | number | Reseller shares in last 7 days |

## Card 13784 — Catalogue Meta (per SKU)

Provides category, description, MRP, and size data.

| Column | Type | Notes |
|--------|------|-------|
| `customer_product_short_id` | string | Product ID (join key) |
| `cust_sku_short_id` | string | SKU ID |
| `clean_product_type` | string | e.g. `womens_clothing__womens_ethnic_wear__kurta_set` |
| `sharable_desc` | string | 1–3 sentence shareable description |
| `size` | string | Individual size (one row per size) |
| `mrp` | number | Original MRP |

## Product URL Format

Built automatically from card 14878 columns:
```
https://qrate.shopdeck.com/{product_name-slug}/catalogue/{customer_product_short_id}/{customer_sku_short_id}
```

## Broadcaster-Applied Filters

The app applies these on top of the raw query results:
- Bestseller only: `orders_last_30d ≥ 10`
- No repeat within 30 days (tracked in `data/shared_history.json`)
- AOV band match per slot (low ≤₹500, mid ₹501–1500, high >₹1500)
- Category match (via `clean_product_type`)
