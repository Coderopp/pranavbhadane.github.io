export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    try {
      let path = "Unknown";
      if (request.method === "POST") {
        const body = await request.json();
        path = body.path || "Unknown";
      }

      const country = request.cf?.country || "Unknown";
      const city = request.cf?.city || "Unknown";
      const region = request.cf?.region || "Unknown";
      const referer = request.headers.get("referer") || "Direct";
      const userAgent = request.headers.get("user-agent") || "Unknown";
      const ip = request.headers.get("cf-connecting-ip") || "Unknown";

      // If it's a request from yourself (optional: ignore your own IP if known, we'll keep it simple)
      
      const emailContent = `New Visitor on your Portfolio!
      
Time: ${new Date().toISOString()}
Page Visited: ${path}
Referrer: ${referer}
Location: ${city}, ${region}, ${country}
IP Address: ${ip}
User Agent: ${userAgent}`;

      // We only fire emails if we have the Resend API Key setup
      if (env.RESEND_API_KEY) {
        ctx.waitUntil(
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "Acme <onboarding@resend.dev>",
              to: [env.TO_EMAIL],
              subject: `🔥 New Portfolio Visitor (${city}, ${country})`,
              text: emailContent
            })
          }).then(res => res.json()).then(data => console.log("Email sent:", data)).catch(e => console.error("Email failed", e))
        );
      }

      return new Response(JSON.stringify({ status: "tracked" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "failed" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
