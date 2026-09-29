---
description: How to create a new API endpoint in BeeFlow
---
# Creating API Endpoints in BeeFlow

1. **Locate the Router**: Endpoints are defined in `server/routes/`. If you are adding an Admin endpoint, it should go in `server/routes/admin/`.
2. **Setup Express Router**: Every route file exports an Express router. Don't forget to import `express` and instantiate the router:
   ```javascript
   const express = require('express');
   const router = express.Router();
   ```
3. **Permissions**: Use the built-in middleware from `../auth/permissions`. 
   - `requireAuth` for any logged-in user.
   - `requireAdmin` for Super Admin access.
   - `requirePermission('your_permission_id')` for specific RBAC access.
4. **Data Layer**: All DB interactions must go through a Store in `server/stores/`. **Do not write raw SQL inside the route.** Import the specific store and call its methods.
5. **Attach Router**: open `server/index.js` and mount your new route file:
   ```javascript
   app.use('/api/my-feature', require('./routes/myFeature'));
   ```
