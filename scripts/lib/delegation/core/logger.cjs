function createDelegationLogger(writer = (line) => process.stderr.write(line + "\n")) {
  return (event, fields = {}) => {
    const body = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ");
    writer(body ? `${event} ${body}` : event);
  };
}

function quote(value) {
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

module.exports = { createDelegationLogger };
