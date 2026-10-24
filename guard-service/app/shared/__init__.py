"""Code shared by guard-service and classify-service.

The source lives here; each service gets a byte-for-byte generated copy as
``app/shared`` (``npm run gen:shared``, checked by ``npm run lint:shared-mirror``).
Never edit the copies: their Docker build contexts are per service, so they
cannot import from this directory.
"""
