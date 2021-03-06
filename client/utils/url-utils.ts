export function uriTag(strings, ...parameters) {
  let out = '';
  let i = 0;

  for (const string of strings) {
    out += string;
    if (parameters[i]) {
      out += encodeURIComponent(String(parameters[i]));
      i++;
    }
  }

  return out;
}
