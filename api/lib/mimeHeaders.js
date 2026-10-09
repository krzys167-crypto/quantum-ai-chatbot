// Defence in depth for the MIME encoders: a header value can never contain a line break, whatever called the
// encoder (the approval gate already refuses control characters; drafts, replies and forwards also quote text from
// received mail, which an attacker controls).
export const headerValue = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
