/**
 * Discord Notification Service
 * Sends rich formatted restock alerts and mentions via Discord Webhook.
 */

async function sendDiscordNotification({
  webhookUrl,
  userId = null,
  productName,
  productUrl,
  imageUrl,
  totalStock,
  previousStock,
  diff,
  restockedModels = [],
  priceFormatted = null
}) {
  if (!webhookUrl) {
    console.warn('[Discord] No webhook URL configured. Skipping notification.');
    return { success: false, reason: 'No webhook URL' };
  }

  // Ping user if userId is provided
  const pingText = userId ? `<@${userId}> ` : '';
  const content = `${pingText}🚨 **SHOPEE RESTOCK ALERT!** An item just came back in stock!`;

  // Build variations restocked text
  let variationsText = 'General product stock restocked!';
  if (restockedModels.length > 0) {
    variationsText = restockedModels
      .map(m => `• **${m.name}**: +${m.diff} (Now **${m.newStock}** in stock)`)
      .join('\n');
  }

  const fields = [
    {
      name: '📦 Current Total Stock',
      value: `**${totalStock}** item${totalStock > 1 ? 's' : ''}`,
      inline: true
    },
    {
      name: '📈 Previous Stock',
      value: `${previousStock} item${previousStock > 1 ? 's' : ''}`,
      inline: true
    },
    {
      name: '⚡ Stock Increase',
      value: `**+${diff}** item${diff > 1 ? 's' : ''}`,
      inline: true
    }
  ];

  if (priceFormatted) {
    fields.push({
      name: '💰 Price',
      value: `**${priceFormatted}**`,
      inline: true
    });
  }

  fields.push({
    name: '🎯 Restocked Variations',
    value: variationsText.slice(0, 1024),
    inline: false
  });

  const embed = {
    title: `🛍️ ${productName}`,
    url: productUrl,
    color: 0x00E676, // Bright Neon / Emerald Green for restock
    description: `Stock just went up! Click the title or link below to checkout immediately before it sells out again!\n\n👉 [**Buy Now on Shopee**](${productUrl})`,
    fields,
    footer: {
      text: 'Shopee Stock Tracker • Automated Restock Alert'
    },
    timestamp: new Date().toISOString()
  };

  if (imageUrl) {
    embed.thumbnail = { url: imageUrl };
  }

  try {
    const payload = JSON.stringify({
      content,
      embeds: [embed]
    });

    const requestHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    };

    let response = await fetch(webhookUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: payload
    });

    if (!response.ok) {
      const errText = await response.text();
      // If Discord or Cloudflare blocks cloud IPs with challenge or rate limit:
      if (response.status === 429 || errText.includes('rate limits') || errText.includes('blocked') || errText.includes('Just a moment')) {
        console.warn('[Discord] Direct Discord IP rate-limited on cloud host. Trying discordapp.com...');
        const altUrl = webhookUrl.replace('discord.com', 'discordapp.com');
        response = await fetch(altUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: payload
        });

        if (response.ok) {
          console.log('[Discord] Notification delivered via discordapp.com successfully!');
          return { success: true };
        }

        // Secondary proxy fallback
        const proxyUrl = webhookUrl
          .replace('discord.com', 'webhook.lewisakura.moe')
          .replace('discordapp.com', 'webhook.lewisakura.moe');

        response = await fetch(proxyUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: payload
        });

        if (response.ok) {
          console.log('[Discord] Notification delivered via proxy successfully!');
          return { success: true };
        }
      }

      console.error(`[Discord] Webhook failed with status ${response.status}:`, errText);
      return { success: false, error: errText };
    }

    console.log('[Discord] Notification sent successfully!');
    return { success: true };
  } catch (err) {
    try {
      const proxyUrl = webhookUrl
        .replace('discord.com', 'webhook.lewisakura.moe')
        .replace('discordapp.com', 'webhook.lewisakura.moe');
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ content, embeds: [embed] })
      });
      if (response.ok) {
        console.log('[Discord] Notification delivered via proxy successfully!');
        return { success: true };
      }
    } catch (e2) {}

    console.error('[Discord] Error sending webhook:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendTestNotification(webhookUrl, userId = null, realProduct = null) {
  if (realProduct && realProduct.name) {
    // Extract models that currently have stock > 0
    const availableModels = (realProduct.models || [])
      .filter(m => m.stock > 0)
      .map(m => ({
        name: m.name,
        diff: m.stock,
        newStock: m.stock
      }));

    return sendDiscordNotification({
      webhookUrl,
      userId,
      productName: `${realProduct.name} (Live Inventory Test)`,
      productUrl: realProduct.url || 'https://shopee.co.id/product/580295413/26906593873',
      imageUrl: realProduct.imageUrl,
      totalStock: realProduct.totalStock || 0,
      previousStock: 0,
      diff: realProduct.totalStock || 0,
      restockedModels: availableModels.length > 0 ? availableModels : [{ name: 'All current variations', diff: realProduct.totalStock, newStock: realProduct.totalStock }],
      priceFormatted: realProduct.priceFormatted
    });
  }

  // Fallback if product has not been scanned yet
  return sendDiscordNotification({
    webhookUrl,
    userId,
    productName: 'DEFECT SALE | NUDETHELABEL (Live Inventory Test)',
    productUrl: 'https://shopee.co.id/product/580295413/26906593873',
    totalStock: 36,
    previousStock: 0,
    diff: 36,
    restockedModels: [
      { name: 'Lace white S', diff: 25, newStock: 25 },
      { name: 'Slip white L', diff: 4, newStock: 4 },
      { name: 'Capri white M', diff: 2, newStock: 2 },
      { name: 'Kira white M', diff: 1, newStock: 1 },
      { name: 'Slouchy white M', diff: 1, newStock: 1 }
    ],
    priceFormatted: 'Rp80.000 - Rp100.000'
  });
}

module.exports = {
  sendDiscordNotification,
  sendTestNotification
};
