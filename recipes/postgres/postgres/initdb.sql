-- ===============================
-- 1️⃣ Create Schemas
-- ===============================
CREATE SCHEMA IF NOT EXISTS "recipe_schema";

CREATE SCHEMA IF NOT EXISTS "keycloak";

-- ===============================
-- 2️⃣ Create Roles
-- ===============================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recipe_user') THEN
        CREATE ROLE "recipe_user" WITH LOGIN PASSWORD 'supersecret';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak') THEN
        CREATE ROLE "keycloak" WITH LOGIN PASSWORD 'supersecret';
    END IF;
END $$;

-- ===============================
-- 3️⃣ Lock down public schema
-- ===============================
REVOKE ALL ON SCHEMA "public"
FROM
  "public";

ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
REVOKE ALL ON TABLES
FROM
  "public";

ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
REVOKE ALL ON SEQUENCES
FROM
  "public";

ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
REVOKE ALL ON FUNCTIONS
FROM
  "public";

-- ===============================
-- 4️⃣ Grant Schema Privileges
-- ===============================
-- recipe role
GRANT ALL ON SCHEMA "recipe_schema" TO "recipe_user";

GRANT ALL ON SCHEMA "keycloak" TO "recipe_user";

-- keycloak role
GRANT ALL ON SCHEMA "keycloak" TO "keycloak";

-- ===============================
-- 5️⃣ Set search_path for each role
-- ===============================
ALTER ROLE "recipe_user"
SET
  search_path = "recipe_schema",
  "keycloak";

ALTER ROLE "keycloak"
SET
  search_path = "keycloak";

-- ===============================
-- 6️⃣ Default privileges inside each schema
-- ===============================
-- recipe_user
ALTER DEFAULT PRIVILEGES FOR ROLE "recipe_user" IN SCHEMA "recipe_schema"
GRANT ALL ON TABLES TO "recipe_user";

ALTER DEFAULT PRIVILEGES FOR ROLE "recipe_user" IN SCHEMA "recipe_schema"
GRANT ALL ON SEQUENCES TO "recipe_user";

ALTER DEFAULT PRIVILEGES FOR ROLE "recipe_user" IN SCHEMA "recipe_schema"
GRANT ALL ON FUNCTIONS TO "recipe_user";

-- keycloak
ALTER DEFAULT PRIVILEGES FOR ROLE "keycloak" IN SCHEMA "keycloak"
GRANT ALL ON TABLES TO "keycloak";

ALTER DEFAULT PRIVILEGES FOR ROLE "keycloak" IN SCHEMA "keycloak"
GRANT ALL ON SEQUENCES TO "keycloak";

ALTER DEFAULT PRIVILEGES FOR ROLE "keycloak" IN SCHEMA "keycloak"
GRANT ALL ON FUNCTIONS TO "keycloak";
