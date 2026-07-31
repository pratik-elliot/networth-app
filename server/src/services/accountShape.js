const { v4: uuid } = require("uuid");

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  if (v === "" || v === null || v === undefined) return null;
  return String(v);
}

/* Storage document -> the exact JSON the client already consumes. */
function toApiAccount(doc) {
  const d = doc || {};
  return {
    id: d._id,
    name: d.name,
    institution: d.institution ?? null,
    country: d.country ?? null,
    currency: d.currency,
    type: d.type,
    interestRate: d.interestRate ?? null,
    interestFrequency: d.interestFrequency ?? null,
    lastKYCDate: d.lastKYCDate ?? null,
    isLiquid: d.isLiquid === undefined ? null : d.isLiquid,
    notes: d.notes ?? null,
    createdDate: d.createdDate ?? null,
    currentValue: d.currentValue ?? null,
    valueDate: d.valueDate ?? null,
    valueUrl: d.valueUrl ?? null,
    purity: d.purity ?? null,
    form: d.form ?? null,
    quantity: d.quantity ?? null,
    city: d.city ?? null,
    vin: d.vin ?? null,
    make: d.make ?? null,
    model: d.model ?? null,
    year: d.year ?? null,
    address: d.address ?? null,
    nominees: (d.nominees || []).map(n => ({ id: n.id, name: n.name, relation: n.relation, percent: n.percent ?? null })),
    images: (d.images || []).map(i => ({
      id: i.id,
      filename: i.filename,
      url: `/api/attachments/${i.id}`,
      mimeType: i.mimeType ?? null,
      sizeBytes: i.sizeBytes ?? null,
      uploadedAt: i.uploadedAt ?? null,
    })),
  };
}

/* Request body -> storage fields. Deliberately ignores id/_id/userId so a
   client cannot reassign ownership of a record. */
function fromApiAccount(b) {
  const body = b || {};
  return {
    name: body.name,
    institution: str(body.institution),
    country: str(body.country),
    currency: body.currency,
    type: body.type,
    interestRate: num(body.interestRate),
    interestFrequency: str(body.interestFrequency),
    lastKYCDate: str(body.lastKYCDate),
    isLiquid: body.isLiquid === null || body.isLiquid === undefined ? null : !!body.isLiquid,
    notes: str(body.notes),
    currentValue: num(body.currentValue),
    valueDate: str(body.valueDate),
    valueUrl: str(body.valueUrl),
    purity: str(body.purity),
    form: str(body.form),
    quantity: num(body.quantity),
    city: str(body.city),
    vin: str(body.vin),
    make: str(body.make),
    model: str(body.model),
    year: str(body.year),
    address: str(body.address),
    nominees: (body.nominees || []).map(n => ({
      id: n.id || uuid(),
      name: n.name,
      relation: n.relation,
      percent: num(n.percent),
    })),
  };
}

module.exports = { toApiAccount, fromApiAccount };
