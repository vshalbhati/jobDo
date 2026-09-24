/* global window */
// ---------------------------------------------------------------------------
// EVERY LinkedIn-specific CSS selector lives here. LinkedIn reskins its job
// pages a few times a year; when the extension suddenly "stops seeing" jobs or
// buttons, this is the only file that should need editing. Each entry is a list
// of fallbacks tried in order, so an old and a new layout can coexist.
// ---------------------------------------------------------------------------
window.LEA = window.LEA || {};

window.LEA.SEL = {
  // --- search results list -------------------------------------------------
  listContainer: [
    '.scaffold-layout__list > div',
    '.scaffold-layout__list',
    '.jobs-search-results-list',
    'ul.jobs-search__results-list'
  ],
  jobCard: [
    'li[data-occludable-job-id]',
    'div.job-card-container',
    'li.jobs-search-results__list-item',
    'li.scaffold-layout__list-item'
  ],
  cardTitle: [
    'a.job-card-container__link',
    'a.job-card-list__title',
    '.job-card-list__title--link',
    '.artdeco-entity-lockup__title a',
    '.artdeco-entity-lockup__title'
  ],
  cardCompany: [
    '.job-card-container__primary-description',
    '.artdeco-entity-lockup__subtitle',
    '.job-card-container__company-name'
  ],
  cardLocation: [
    '.job-card-container__metadata-item',
    '.artdeco-entity-lockup__caption',
    '.job-card-container__metadata-wrapper li'
  ],
  cardFooter: [
    '.job-card-container__footer-wrapper',
    '.job-card-list__footer-wrapper',
    '.job-card-container__footer-item'
  ],
  paginationNext: [
    'button[aria-label="View next page"]',
    '.jobs-search-pagination__button--next',
    'button.artdeco-pagination__button--next'
  ],

  // --- right-hand job details pane ----------------------------------------
  detailsTitle: [
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    '.t-24.job-details-jobs-unified-top-card__job-title'
  ],
  detailsCompany: [
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name'
  ],
  detailsDescription: [
    '#job-details',
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.jobs-box__html-content'
  ],
  seeMore: [
    '.jobs-description__footer-button',
    'button[aria-label*="see more" i]',
    'button.show-more-less-html__button--more'
  ],
  applyButton: [
    '.jobs-apply-button',
    'button.jobs-apply-button--top-card',
    '.jobs-s-apply button'
  ],

  // --- Easy Apply modal ----------------------------------------------------
  modal: [
    '.jobs-easy-apply-modal',
    'div[role="dialog"][aria-labelledby*="easy-apply" i]',
    'div[role="dialog"][aria-labelledby*="jobs-apply" i]',
    '.artdeco-modal--layer-default'
  ],
  modalContent: [
    '.jobs-easy-apply-content',
    '.artdeco-modal__content',
    '.jobs-easy-apply-modal__content'
  ],
  modalFooter: [
    '.jobs-easy-apply-modal footer',
    '.artdeco-modal__actionbar',
    'footer[role="presentation"]',
    'footer'
  ],
  progressMeter: [
    '.artdeco-completeness-meter-linear__progress-element',
    'progress.artdeco-completeness-meter-linear__progress-element',
    'div[role="progressbar"]'
  ],
  dismiss: [
    'button[aria-label="Dismiss"]',
    '.artdeco-modal__dismiss',
    'button[data-test-modal-close-btn]'
  ],
  discardConfirm: [
    'button[data-control-name="discard_application_confirm_btn"]',
    'button[data-test-dialog-secondary-btn]'
  ],

  // --- fields inside the modal --------------------------------------------
  formGroup: [
    '.fb-dash-form-element',
    'div[data-test-form-element]',
    '.jobs-easy-apply-form-section__grouping',
    '.jobs-easy-apply-form-element'
  ],
  fieldError: [
    '.artdeco-inline-feedback--error',
    '.fb-dash-form-element__error-field',
    '[data-test-form-element-error-messages]'
  ],
  followCompany: [
    '#follow-company-checkbox',
    'input[type="checkbox"][id*="follow" i]'
  ],
  resumeCard: [
    '.jobs-document-upload-redesign-card__container',
    '.jobs-resume-picker__resume',
    '.jobs-document-upload__container'
  ],
  resumeFileInput: [
    'input[type="file"][name="file"]',
    'input[type="file"][id*="upload-resume" i]',
    'input[type="file"]'
  ],
  typeaheadOption: [
    '.basic-typeahead__selectable',
    '.search-typeahead-v2__hit',
    'div[role="option"]'
  ],

  // --- post-submit confirmation -------------------------------------------
  postApplyModal: [
    '.artdeco-modal[role="alertdialog"]',
    '.jpac-modal-header',
    '.artdeco-modal'
  ]
};

// Button lookups are text-driven rather than class-driven: LinkedIn's button
// labels are far more stable than its class names, and they are localised
// through aria-label which we also check.
window.LEA.BTN = {
  next: [/^continue to next step$/i, /^next$/i],
  review: [/^review your application$/i, /^review$/i],
  submit: [/^submit application$/i, /^submit$/i],
  done: [/^done$/i, /^close$/i, /^not now$/i],
  discard: [/^discard$/i, /^discard application$/i]
};
