const labels: Record<string, string> = {
  numeric_input_validator_required:
    'CSV and NPY uploads are paused until the isolated validation runtime is updated',
};

export const label = (value: string) =>
  labels[value] ?? value.replaceAll('_', ' ');
