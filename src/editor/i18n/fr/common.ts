// Words many screens share. Areas keep their own texts in their own file.
export default {
  cancel: 'Annuler',
  close: 'Fermer',
  save: 'Enregistrer',
  check: 'Vérifier',
  copyCommand: (text: string) => `Copier « ${text} »`,
  commandCopied: 'Commande copiée',
  formats: { '16:9': 'Paysage 16:9', '9:16': 'Vertical 9:16', '1:1': 'Carré 1:1', '4:5': 'Portrait 4:5' },
  visibilities: {
    private: 'Privée',
    unlisted: 'Non répertoriée',
    public: 'Publique',
    connections: 'Mes relations',
    draft: 'Brouillon',
  },
  efforts: {
    low: 'Effort faible',
    medium: 'Effort moyen',
    high: 'Effort élevé',
    xhigh: 'Effort très élevé',
    max: 'Effort maximal',
    ultra: 'Effort ultra',
  },
};
