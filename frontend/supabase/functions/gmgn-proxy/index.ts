// Supabase Edge Function to proxy GMGN API calls
// This bypasses Cloudflare blocking from browser requests

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    })
  }

  try {
    const GMGN_API_BASE = 'https://gmgn.ai/api/v1'
    const GMGN_API_KEY=*** || 'gmgn_d6464c033675a99e51bf16c4e2634c97'
    
    const body = await req.json()
    const path = body.path
    const params = body.params || {}
    
    if (!path) {
      return new Response(
        JSON.stringify({ error: 'Missing path parameter' }),
        { 
          status: 400, 
          headers: { 
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json' 
          } 
        }
      )
    }

    // Build GMGN API URL
    const url = new URL(`${GMGN_API_BASE}${path}`)
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value))
    })

    console.log(`Calling GMGN API: ${url.toString()}`)

    // Call GMGN API
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${GMGN_API_KEY}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`GMGN API error: ${response.status} - ${errorText}`)
      return new Response(
        JSON.stringify({ error: `GMGN API error: ${response.status}`, details: errorText }),
        { 
          status: response.status, 
          headers: { 
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json' 
          } 
        }
      )
    }

    const data = await response.json()
    
    return new Response(
      JSON.stringify(data),
      { 
        status: 200, 
        headers: { 
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json' 
        } 
      }
    )
  } catch (error) {
    console.error('Error:', error.message)
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500, 
        headers: { 
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json' 
        } 
      }
    )
  }
})
