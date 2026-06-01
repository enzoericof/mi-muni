const ragQuestions = [
  {
    id: 'licencia-renovacion',
    question: 'Que necesito para renovar la licencia de conducir en Asuncion?',
    expectedAny: ['licencia', 'conducir'],
  },
  {
    id: 'habilitacion-comercial',
    question: 'Como habilito un comercio o negocio?',
    expectedAny: ['habilitacion', 'comercial', 'negocio'],
  },
  {
    id: 'patente-comercial',
    question: 'Donde encuentro informacion para pagar patente comercial?',
    expectedAny: ['patente', 'comercial'],
  },
  {
    id: 'sin-respuesta-municipal',
    question: 'Como tramito un pasaporte paraguayo?',
    expectedNoGrounding: true,
  },
]

export default ragQuestions
