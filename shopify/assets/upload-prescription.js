(function () {
  function onSubmit(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const endpoint = form.dataset.endpoint;
    const statusEl = form.querySelector('[data-prescription-status]');
    const submitBtn = form.querySelector('.prescription-upload__submit');
    const fileInput = form.querySelector('input[type="file"]');

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
    const file = fileInput.files[0];

    if (file && !ALLOWED_TYPES.includes(file.type)) {
      statusEl.textContent = 'Please upload a JPG, PNG, or PDF file.';
      statusEl.classList.add('is-error');
      return;
    }

    const formData = new FormData(form);
    submitBtn.disabled = true;
    statusEl.classList.remove('is-error', 'is-success');
    statusEl.textContent = 'Uploading...';

    fetch(endpoint, {
      method: 'POST',
      body: formData,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          throw new Error(data.message || 'Something went wrong. Please try again.');
        }
        statusEl.textContent = data.message || 'Prescription sent successfully!';
        statusEl.classList.add('is-success');
        form.reset();
      })
      .catch((err) => {
        statusEl.textContent = err.message || 'Upload failed. Please try again.';
        statusEl.classList.add('is-error');
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-prescription-form]').forEach(function (form) {
      form.addEventListener('submit', onSubmit);
    });
  });
})();
