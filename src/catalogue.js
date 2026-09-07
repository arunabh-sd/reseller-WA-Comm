import axios from "axios";

const BASE = process.env.QRATE_API_BASE || "https://api.shopdeck.com/reseller/v1";

const api = axios.create({
  baseURL: BASE,
  timeout: 10000,
});

export async function fetchProducts({ page = 1, limit = 50, productType, sortBy = "popularity" } = {}) {
  const params = { page, limit, sort_by: sortBy };
  if (productType) params.product_types = productType;

  const { data } = await api.get("/catalogue/products", { params });
  if (!data.success) throw new Error("Catalogue API error");
  return data.data.items;
}

export async function fetchProductById(productShortId) {
  const { data } = await api.get(`/catalogue/products/${productShortId}`);
  if (!data.success) throw new Error(`Product ${productShortId} not found`);
  return data.data;
}

// Extracts the best image URL from a product listing item
export function getProductImage(product) {
  const img = product.images?.[0];
  if (!img) return null;
  return img.src_url;
}

// Builds the WhatsApp caption for a product
export function buildCaption(product) {
  const title = product.title || "";
  const price = product.effective_price_display_string || "";
  const mrp   = product.mrp_display_string || "";
  const disc  = product.discount_text || "";

  // Use forward_cta from product detail if available
  if (product.content?.forward_cta) {
    return product.content.forward_cta;
  }

  const lines = [`*${title}*`, ""];
  if (mrp && disc) lines.push(`~~${mrp}~~ ${price}  |  *${disc}*`);
  else if (price) lines.push(price);

  return lines.join("\n");
}
