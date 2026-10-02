import type fr from '../fr/common';

export default {
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',
  check: 'Check',
  copyCommand: (text: string) => `Copy "${text}"`,
  commandCopied: 'Command copied',
  formats: { '16:9': 'Landscape 16:9', '9:16': 'Vertical 9:16', '1:1': 'Square 1:1', '4:5': 'Portrait 4:5' },
  visibilities: {
    private: 'Private',
    unlisted: 'Unlisted',
    public: 'Public',
    connections: 'Connections',
    draft: 'Draft',
  },
  efforts: {
    low: 'Low effort',
    medium: 'Medium effort',
    high: 'High effort',
    xhigh: 'Very high effort',
    max: 'Max effort',
  },
} satisfies typeof fr;
