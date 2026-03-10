require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =========================================================
// CONFIG
// =========================================================
const PORT = Number(process.env.PORT || 3000);

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// =========================================================
// VALIDACIÓN DE VARIABLES
// =========================================================
function requerirEnv(nombre, valor) {
  if (!valor || String(valor).trim() === "") {
    throw new Error(`Falta variable de entorno: ${nombre}`);
  }
  return valueOrTrim(valor);
}

function valueOrTrim(valor) {
  return typeof valor === "string" ? valor.trim() : valor;
}

const ENV = {
  PORT,
  META_VERIFY_TOKEN: requerirEnv("META_VERIFY_TOKEN", META_VERIFY_TOKEN),
  META_PHONE_NUMBER_ID: requerirEnv("META_PHONE_NUMBER_ID", META_PHONE_NUMBER_ID),
  META_ACCESS_TOKEN: requerirEnv("META_ACCESS_TOKEN", META_ACCESS_TOKEN),
  OPENAI_API_KEY: requerirEnv("OPENAI_API_KEY", OPENAI_API_KEY),
  OPENAI_MODEL: valueOrTrim(OPENAI_MODEL),
  SUPABASE_URL: requerirEnv("SUPABASE_URL", SUPABASE_URL),
  SUPABASE_SERVICE_ROLE_KEY: requerirEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
};

console.log("Variables cargadas OK:", {
  PORT: ENV.PORT,
  META_PHONE_NUMBER_ID: ENV.META_PHONE_NUMBER_ID,
  OPENAI_MODEL: ENV.OPENAI_MODEL,
  SUPABASE_URL: ENV.SUPABASE_URL
});

const supabase = createClient(
  ENV.SUPABASE_URL,
  ENV.SUPABASE_SERVICE_ROLE_KEY
);

// =========================================================
// HELPERS
// =========================================================
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function limpiarTelefono(numero) {
  return String(numero || "").replace(/[^\d+]/g, "").trim();
}

function normalizarIngreso(valor) {
  if (valor == null || valor === "") return null;
  if (typeof valor === "number") return valor;
  const solo = String(valor)
    .replace(/[^\d.,]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = Number(solo);
  return Number.isNaN(n) ? null : n;
}

async function enviarTextoWhatsApp(to, body) {
  const url = `https://graph.facebook.com/v21.0/${ENV.META_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.META_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error("Error enviando WhatsApp:", data);
    throw new Error("No se pudo enviar mensaje por WhatsApp");
  }

  return data;
}

async function guardarMensajeDB({
  lead_id = null,
  telefono,
  direccion,
  remitente,
  remitente_id = null,
  contenido,
  tipo_contenido = "TEXTO",
  wa_message_id = null,
  estado_mensaje = null
}) {
  const { error } = await supabase.rpc("guardar_mensaje", {
    p_lead_id: lead_id,
    p_telefono: telefono,
    p_direccion: direccion,
    p_remitente: remitente,
    p_remitente_id: remitente_id,
    p_contenido: contenido,
    p_tipo_contenido: tipo_contenido,
    p_url_archivo: null,
    p_nombre_archivo: null,
    p_mime_type: null,
    p_tamano_bytes: null,
    p_wa_message_id: wa_message_id,
    p_estado_mensaje: estado_mensaje
  });

  if (error) {
    console.error("Error guardando mensaje en DB:", error);
  }
}

async function obtenerLeadPorTelefono(telefono) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("telefono", telefono)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Error buscando lead por teléfono:", error);
    return null;
  }

  return data || null;
}

async function asegurarBotEstado(telefono, fuente = null) {
  const { error } = await supabase.rpc("crear_o_actualizar_bot_estado_inicial", {
    p_telefono: telefono,
    p_fuente_campana: fuente
  });

  if (error) {
    console.error("Error creando/actualizando bot_estado:", error);
  }
}

async function obtenerEstadoBot(telefono) {
  const { data, error } = await supabase.rpc("obtener_estado_bot_simple", {
    p_telefono: telefono
  });

  if (error) {
    console.error("Error obteniendo estado bot:", error);
    return null;
  }

  return Array.isArray(data) ? data[0] : data;
}

async function prepararPayloadIA(telefono, mensajeCliente) {
  const { data, error } = await supabase.rpc("preparar_payload_openai", {
    p_telefono: telefono,
    p_mensaje_cliente: mensajeCliente
  });

  if (error) {
    console.error("Error preparando payload OpenAI:", error);
    throw error;
  }

  return data;
}

async function llamarOpenAI({ prompt_sistema, contexto_actual, mensaje_cliente }) {
  const messages = [
    {
      role: "system",
      content: prompt_sistema
    },
    {
      role: "user",
      content:
`CONTEXTO ACTUAL DEL BOT:
${JSON.stringify(contexto_actual, null, 2)}

MENSAJE DEL CLIENTE:
${mensaje_cliente}

Respondé SOLO en JSON válido.`
    }
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: ENV.OPENAI_MODEL,
      messages,
      temperature: 0.3
    })
  });

  const data = await resp.json();

  if (!resp.ok) {
    console.error("Error OpenAI:", data);
    throw new Error("Error llamando a OpenAI: " + (data.error?.message || "desconocido"));
  }

  const texto = data.choices?.[0]?.message?.content || "";

  // Limpiar posibles backticks de markdown que OpenAI a veces agrega
  const textoLimpio = texto
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const json = safeJsonParse(textoLimpio);
  if (!json) {
    console.error("OpenAI devolvió algo no parseable:", texto);
    throw new Error("La respuesta de OpenAI no vino en JSON válido");
  }

  return json;
}

async function procesarRespuestaIA(telefono, respuestaIA) {
  const datos = respuestaIA.datos_extraidos || {};

  const { data, error } = await supabase.rpc("procesar_respuesta_ia_bot", {
    p_telefono: telefono,
    p_accion: respuestaIA.accion || "PREGUNTAR",
    p_mensaje_cliente: respuestaIA.mensaje_cliente || "Gracias. Seguimos con tu consulta.",
    p_nombre: datos.nombre || null,
    p_zona: datos.zona || null,
    p_modalidad: datos.modalidad || null,
    p_ingreso_aprox: normalizarIngreso(datos.ingreso_aprox),
    p_faltan_datos: respuestaIA.faltan_datos || [],
    p_resumen_lead: respuestaIA.resumen_lead || null
  });

  if (error) {
    console.error("Error procesando respuesta IA:", error);
    throw error;
  }

  return data;
}

async function obtenerChecklistLead(leadId) {
  const { data, error } = await supabase.rpc("obtener_checklist_prefirma", {
    p_lead_id: leadId
  });

  if (error) {
    console.error("Error obteniendo checklist:", error);
    return [];
  }

  return data || [];
}

// =========================================================
// EMAIL PREFIRMA (base)
// =========================================================
async function registrarAlertaPrefirma(leadId) {
  const { error } = await supabase
    .from("alertas")
    .insert({
      lead_id: leadId,
      tipo_alerta: "PRE_FIRMA",
      estado_alerta: "PENDIENTE",
      mensaje: "Se debe enviar el correo de pre-firma con checklist."
    });

  if (error) {
    console.error("Error registrando alerta de pre-firma:", error);
  }
}

// =========================================================
// WEBHOOK META
// =========================================================
app.get("/meta/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === ENV.META_VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/meta/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (!body.object) {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // ESTADOS DE MENSAJE
    if (value?.statuses?.length) {
      for (const status of value.statuses) {
        const waMessageId = status.id;
        const estado = status.status;

        const { error } = await supabase
          .from("mensajes")
          .update({ estado_mensaje: estado })
          .eq("wa_message_id", waMessageId);

        if (error) {
          console.error("Error actualizando estado mensaje:", error);
        }
      }

      return res.sendStatus(200);
    }

    // MENSAJES ENTRANTES
    if (value?.messages?.length) {
      for (const msg of value.messages) {
        const from = limpiarTelefono(msg.from);
        const waMessageId = msg.id;
        const tipo = msg.type;

        let textoCliente = "";

        if (tipo === "text") {
          textoCliente = msg.text?.body || "";
        } else {
          textoCliente = `[${tipo}]`;
        }

        let lead = await obtenerLeadPorTelefono(from);

        await guardarMensajeDB({
          lead_id: lead?.id || null,
          telefono: from,
          direccion: "ENTRANTE",
          remitente: "CLIENTE",
          contenido: textoCliente,
          tipo_contenido: "TEXTO",
          wa_message_id: waMessageId,
          estado_mensaje: "received"
        });

        if (lead) {
          const mensajeContinuacion =
            "Tu consulta ya está en seguimiento con un asesor. En breve continuará la atención.";

          const respMeta = await enviarTextoWhatsApp(from, mensajeContinuacion);

          await guardarMensajeDB({
            lead_id: lead.id,
            telefono: from,
            direccion: "SALIENTE",
            remitente: "BOT",
            contenido: mensajeContinuacion,
            wa_message_id: respMeta?.messages?.[0]?.id || null,
            estado_mensaje: "sent"
          });

          continue;
        }

        await asegurarBotEstado(from, "WhatsApp");

        const payloadIA = await prepararPayloadIA(from, textoCliente);
        const respuestaIA = await llamarOpenAI(payloadIA);
        const resultadoProceso = await procesarRespuestaIA(from, respuestaIA);

        const textoSalida =
          resultadoProceso?.mensaje_cliente ||
          respuestaIA?.mensaje_cliente ||
          "Gracias. Seguimos con tu consulta.";

        const respMeta = await enviarTextoWhatsApp(from, textoSalida);

        const estadoBotActual = await obtenerEstadoBot(from);

        await guardarMensajeDB({
          lead_id: estadoBotActual?.lead_id || null,
          telefono: from,
          direccion: "SALIENTE",
          remitente: "BOT",
          contenido: textoSalida,
          wa_message_id: respMeta?.messages?.[0]?.id || null,
          estado_mensaje: "sent"
        });

        if (resultadoProceso?.accion === "DERIVAR" && resultadoProceso?.lead_id) {
          console.log("Lead derivado:", resultadoProceso.lead_id);
        }
      }

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Error general webhook:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================================================
// ENDPOINTS AUXILIARES
// =========================================================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    servicio: "Zafiro CRM Backend",
    modelo_ia: ENV.OPENAI_MODEL,
    timestamp: new Date().toISOString()
  });
});

app.post("/lead/:id/prefirma", async (req, res) => {
  try {
    const leadId = req.params.id;

    const { error } = await supabase.rpc("enviar_lead_a_prefirma", {
      p_lead_id: leadId,
      p_usuario_id: null
    });

    if (error) throw error;

    const checklist = await obtenerChecklistLead(leadId);
    await registrarAlertaPrefirma(leadId);

    return res.json({
      ok: true,
      mensaje: "Lead enviado a PRE-FIRMA",
      checklist
    });
  } catch (error) {
    console.error("Error enviando a pre-firma:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =========================================================
// INICIO
// =========================================================
app.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(`Zafiro CRM backend corriendo en puerto ${ENV.PORT}`);
});
