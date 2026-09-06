using System;
using System.Collections.Generic;

namespace MyApp.Models
{
    public interface IGreeter
    {
        string Greet();
    }

    public struct Point
    {
        public int X;
        public int Y;
    }

    public enum Role
    {
        Admin,
        Member,
    }

    [Serializable]
    public class User : BaseEntity, IGreeter
    {
        public const int MaxAge = 120;

        private string name;

        public string Name
        {
            get { return name; }
            set { name = value; }
        }

        public User(string name)
        {
            this.name = name;
        }

        public string Greet()
        {
            return "Hello, " + name;
        }

        public static User Create(string name)
        {
            var user = new User(name);
            Logger.Log(user.Greet());
            return user;
        }
    }

    namespace Admin
    {
        public class AuditLog
        {
            public void Record(string message)
            {
                Console.WriteLine(message);
            }
        }
    }
}
