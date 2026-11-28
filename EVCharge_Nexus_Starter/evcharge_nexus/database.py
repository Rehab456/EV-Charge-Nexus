import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()


class DatabaseConnection:

    def __init__(self):
        database_url = os.getenv("DATABASE_URL")

        if not database_url:
            raise RuntimeError("DATABASE_URL is missing")

        self.connection = psycopg2.connect(
            database_url,
            cursor_factory=RealDictCursor
        )

    def execute(self, sql, params=None):
        cursor = self.connection.cursor()

        sql = sql.replace("?", "%s")

        if params is None:
            cursor.execute(sql)
        else:
            cursor.execute(sql, params)

        return cursor

    def cursor(self):
        return self.connection.cursor()

    def commit(self):
        self.connection.commit()

    def rollback(self):
        self.connection.rollback()

    def close(self):
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        finally:
            self.close()


def get_connection():
    return DatabaseConnection()