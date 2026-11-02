export const normalizePhoneNumber = (value: string | undefined | null) => {
  const digitsOnly = (value ?? '').replace(/\D/g, '');

  if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    return `+234${digitsOnly.slice(1)}`;
  }

  if (digitsOnly.length === 10) {
    return `+234${digitsOnly}`;
  }

  if (digitsOnly.length === 13 && digitsOnly.startsWith('234')) {
    return `+${digitsOnly}`;
  }

  if ((value ?? '').startsWith('+') && digitsOnly.length >= 10) {
    return `+${digitsOnly}`;
  }

  return null;
};

export const toLocalPhoneNumber = (value: string) => {
  const digitsOnly = value.replace(/\D/g, '');

  if (digitsOnly.startsWith('234') && digitsOnly.length === 13) {
    return `0${digitsOnly.slice(3)}`;
  }

  if (digitsOnly.length === 10) {
    return `0${digitsOnly}`;
  }

  return digitsOnly.slice(0, 11);
};
