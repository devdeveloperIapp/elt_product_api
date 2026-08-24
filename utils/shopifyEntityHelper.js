// node-fetch v3 is ESM-only — use Node 18+ global fetch instead

/**
 * Shopify Entity Helper Functions for ETL
 */

class ShopifyETLHelper {
  
  /**
   * Validate and normalize Shopify entity data
   */
  static normalizeShopifyEntityData(entityData, entityType) {
    const normalized = {
      ...entityData,
      entityType: entityType.toLowerCase(),
      lastSynced: new Date(),
      metadata: {
        ...entityData.metadata,
        normalizedAt: new Date().toISOString()
      }
    };

    // Entity-specific normalization
    switch (entityType.toLowerCase()) {
      case 'product':
        return ShopifyETLHelper.normalizeShopifyProductData(normalized);
      case 'order':
        return ShopifyETLHelper.normalizeShopifyOrderData(normalized);
      case 'customer':
        return ShopifyETLHelper.normalizeShopifyCustomerData(normalized);
      case 'collection':
        return ShopifyETLHelper.normalizeShopifyCollectionData(normalized);
      case 'inventory':
        return ShopifyETLHelper.normalizeShopifyInventoryData(normalized);
      default:
        return normalized;
    }
  }

  /**
   * Normalize Shopify product data
   */
  static normalizeShopifyProductData(productData) {
    return {
      ...productData,
      title: productData.title || '',
      handle: productData.handle || '',
      variants: Array.isArray(productData.variants) ? productData.variants.map(variant => ({
        id: variant.id,
        title: variant.title || '',
        price: variant.price || '0.00',
        sku: variant.sku || '',
        inventory_quantity: variant.inventory_quantity || 0
      })) : [],
      images: Array.isArray(productData.images) ? productData.images.map(img => ({
        id: img.id,
        src: img.src,
        alt: img.alt || ''
      })) : []
    };
  }

  /**
   * Normalize Shopify order data
   */
  static normalizeShopifyOrderData(orderData) {
    return {
      ...orderData,
      order_number: orderData.order_number || '',
      financial_status: orderData.financial_status || '',
      fulfillment_status: orderData.fulfillment_status || '',
      line_items: Array.isArray(orderData.line_items) ? orderData.line_items.map(item => ({
        id: item.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        title: item.title || '',
        quantity: item.quantity || 0,
        price: item.price || '0.00'
      })) : [],
      customer: orderData.customer ? {
        id: orderData.customer.id,
        email: orderData.customer.email || ''
      } : null
    };
  }

  /**
   * Normalize Shopify customer data
   */
  static normalizeShopifyCustomerData(customerData) {
    return {
      ...customerData,
      email: customerData.email || '',
      first_name: customerData.first_name || '',
      last_name: customerData.last_name || '',
      orders_count: customerData.orders_count || 0,
      total_spent: customerData.total_spent || '0.00'
    };
  }

  /**
   * Normalize Shopify collection data
   */
  static normalizeShopifyCollectionData(collectionData) {
    return {
      ...collectionData,
      title: collectionData.title || '',
      handle: collectionData.handle || '',
      products_count: collectionData.products_count || 0
    };
  }

  /**
   * Normalize Shopify inventory data
   */
  static normalizeShopifyInventoryData(inventoryData) {
    return {
      ...inventoryData,
      inventory_item_id: inventoryData.inventory_item_id,
      available: inventoryData.available || 0,
      location_id: inventoryData.location_id
    };
  }

  /**
   * Read data from Shopify API
   */
  static async readShopifyData(settings, entityType, activeColumns, chunkSize = 250) {
    try {
      console.log(`📖 Reading Shopify data for entity: ${entityType}`);
      
      const { 
        shop_domain, 
        access_token, 
        api_version = '2024-01' 
      } = settings;

      if (!shop_domain || !access_token) {
        throw new Error('Shopify credentials missing. Required: shop_domain, access_token');
      }

      const baseUrl = `https://${shop_domain}/admin/api/${api_version}`;
      
      const entityMap = {
        'products': 'products',
        'orders': 'orders',
        'customers': 'customers',
        'collections': 'custom_collections',
        'inventory': 'inventory_items'
      };

      const endpoint = entityMap[entityType.toLowerCase()] || entityType;
      
      let allEntities = [];
      let nextPage = null;
      let page = 1;

      console.log(`🔍 Fetching ${entityType} data from Shopify...`);

      do {
        let url = `${baseUrl}/${endpoint}.json?limit=${chunkSize}`;
        
        // Add pagination parameters
        if (nextPage) {
          url = nextPage;
        }

        console.log(`📥 Fetching page ${page}: ${url.substring(0, 100)}...`);

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Shopify-Access-Token': access_token,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          const errorText = await response.text();
          
          if (response.status === 401) {
            throw new Error('Shopify access token expired or invalid.');
          }
          
          if (response.status === 429) {
            console.log('⚠️ Rate limit hit, waiting...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          
          throw new Error(`Shopify API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const entities = data[endpoint] || data[entityType] || [];
        
        console.log(`✅ Fetched page ${page}: ${entities.length} ${entityType} records`);

        // Transform Shopify data to match column structure
        const transformedChunk = entities.map(shopifyEntity => {
          const row = {};
          
          activeColumns.forEach(column => {
            const value = ShopifyETLHelper.getNestedShopifyValue(shopifyEntity, column);
            row[column] = value !== undefined ? value : null;
          });
          
          return row;
        });

        allEntities = allEntities.concat(transformedChunk);

        // Check for next page in Link header
        const linkHeader = response.headers.get('link');
        nextPage = ShopifyETLHelper.extractNextPageUrl(linkHeader);
        page++;

        // Respect rate limits - Shopify allows 2 requests per second
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } while (nextPage && page < 50); // Safety limit of 50 pages

      console.log(`🎉 Total ${allEntities.length} ${entityType} records fetched from Shopify`);
      return allEntities;

    } catch (error) {
      console.error('❌ Error reading Shopify data:', error.message);
      
      if (error.message.includes('token expired') || error.message.includes('401')) {
        throw new Error('Shopify authentication failed. Please refresh your connection.');
      } else if (error.message.includes('rate limit') || error.message.includes('429')) {
        throw new Error('Shopify API rate limit exceeded. Please try again later.');
      }
      
      throw error;
    }
  }

  /**
   * Extract next page URL from Shopify Link header
   */
  static extractNextPageUrl(linkHeader) {
    if (!linkHeader) return null;
    
    const links = linkHeader.split(',');
    for (const link of links) {
      if (link.includes('rel="next"')) {
        const match = link.match(/<([^>]+)>/);
        return match ? match[1] : null;
      }
    }
    return null;
  }

  /**
   * Get nested value from Shopify object
   */
  static getNestedShopifyValue(obj, path) {
    try {
      return path.split('.').reduce((current, key) => {
        if (current && typeof current === 'object') {
          return current[key] !== undefined ? current[key] : undefined;
        }
        return undefined;
      }, obj);
    } catch (error) {
      console.warn(`⚠️ Could not access path ${path} in Shopify object`);
      return undefined;
    }
  }

  /**
   * Prepare Shopify webhook data for entity processing
   */
  static prepareShopifyWebhookEntity(webhookData, topic) {
    const topicParts = topic.split('/');
    const entityType = topicParts[0]; // products, orders, customers, etc.
    const action = topicParts[1]; // create, update, delete
    
    const baseEntity = {
      shopifyId: webhookData.id?.toString(),
      entityType: ShopifyETLHelper.mapShopifyWebhookTopicToEntityType(entityType),
      rawData: webhookData,
      webhook: {
        topic,
        action,
        receivedAt: new Date()
      }
    };

    return ShopifyETLHelper.normalizeShopifyEntityData(baseEntity, baseEntity.entityType);
  }

  /**
   * Map Shopify webhook topic to entity type
   */
  static mapShopifyWebhookTopicToEntityType(topic) {
    const mapping = {
      'products': 'product',
      'orders': 'order',
      'customers': 'customer',
      'collections': 'collection',
      'inventory_items': 'inventory'
    };
    
    return mapping[topic] || topic;
  }

  /**
   * Validate Shopify source configuration
   */
  static validateShopifyConfig(shopifyConfig) {
    const errors = [];
    
    if (!shopifyConfig.shop_domain) {
      errors.push('Shop domain is required');
    }
    
    if (!shopifyConfig.access_token) {
      errors.push('Access token is required');
    }
    
    // Validate shop domain format
    if (shopifyConfig.shop_domain && !shopifyConfig.shop_domain.match(/\.myshopify\.com$/)) {
      errors.push('Shop domain should end with .myshopify.com');
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Check Shopify data availability
   */
  static async checkShopifyDataAvailability(settings, entityType) {
    const { shop_domain, access_token, api_version = '2024-01' } = settings;
    
    try {
      console.log(`🔍 Checking data availability for: ${entityType}`);
      
      const entityMap = {
        'products': 'products',
        'orders': 'orders',
        'customers': 'customers',
        'collections': 'custom_collections',
        'inventory': 'inventory_items'
      };

      const endpoint = entityMap[entityType.toLowerCase()] || entityType;
      const url = `https://${shop_domain}/admin/api/${api_version}/${endpoint}/count.json`;
      
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': access_token
        }
      });
      
      if (!response.ok) {
        console.log(`⚠️ ${entityType} count query failed: ${response.status}`);
        return false;
      }
      
      const data = await response.json();
      const count = data.count || 0;
      console.log(`📊 ${entityType} has ${count} records`);
      return count > 0;
      
    } catch (error) {
      console.error(`❌ Error checking ${entityType}:`, error.message);
      return false;
    }
  }

  /**
   * Enhanced data cleaning for Shopify data
   */
  static cleanShopifyDataForInsertion(rows, activeColumns) {
    return rows.map((row) => {
      const cleanedRow = {};
      
      activeColumns.forEach((col) => {
        let value = row[col];

        // Handle null/undefined
        if (value === null || value === undefined || value === '') {
          cleanedRow[col] = null;
          return;
        }

        // Handle Shopify-specific objects
        if (typeof value === 'object' && value !== null) {
          // Handle money objects
          if (value.amount && value.currency_code) {
            cleanedRow[col] = parseFloat(value.amount) || 0;
            return;
          }
          
          // Handle address objects
          if (value.address1 || value.city || value.country) {
            cleanedRow[col] = JSON.stringify(value);
            return;
          }
          
          // Default object handling
          cleanedRow[col] = JSON.stringify(value);
          return;
        }

        // Handle Shopify-specific string formats
        if (typeof value === 'string') {
          // Handle price strings
          if (col.includes('price') && value.match(/^\d+\.\d{2}$/)) {
            cleanedRow[col] = parseFloat(value);
            return;
          }
          
          // Handle numeric IDs
          if ((col.includes('id') || col === 'id') && !isNaN(value)) {
            cleanedRow[col] = parseInt(value);
            return;
          }
          
          // Handle boolean strings
          if (value === 'true' || value === 'false') {
            cleanedRow[col] = value === 'true';
            return;
          }
        }

        cleanedRow[col] = value;
      });
      
      return cleanedRow;
    });
  }

  /**
   * Get all available Shopify entities
   */
  static getShopifyEntities() {
    return {
      'products': 'Products',
      'orders': 'Orders', 
      'customers': 'Customers',
      'collections': 'Collections',
      'inventory': 'Inventory Items'
    };
  }

  /**
   * Test Shopify connection
   */
  static async testShopifyConnection(settings) {
    try {
      const { shop_domain, access_token, api_version = '2024-01' } = settings;
      
      const url = `https://${shop_domain}/admin/api/${api_version}/shop.json`;
      
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': access_token,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Shopify API returned ${response.status}: ${await response.text()}`);
      }

      const shopData = await response.json();
      return {
        success: true,
        shop: shopData.shop,
        message: 'Successfully connected to Shopify store'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to connect to Shopify store'
      };
    }
  }
}

module.exports = ShopifyETLHelper;